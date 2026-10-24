import Fs from 'fs'
import Os from 'os'
import Path from 'path'

import test from 'ava'
import { z } from 'zod'

import { generateServiceAccount, MockGoogleSheetsApi } from './_mock/google-sheets-api.js'

import {
  useDocumentsSheet,
  useSpreadsheetTable,
  useWorksheetWithServiceAccount,
  useWorksheetWithServiceAccountFile,
} from './index.js'

// All HTTP traffic to Google is served by the in-memory mock; real network access is disabled.
const api = new MockGoogleSheetsApi()
const account = generateServiceAccount()
const serviceAccount = { client_email: account.client_email, private_key: account.private_key }

test.before(() => {
  api.registerServiceAccount(account)
  api.install()
})

test.after.always(() => {
  MockGoogleSheetsApi.uninstall()
})

const dataSchema = z.object({
  number: z.coerce.number(),
  string: z.string(),
})

let seq = 0
function newSpreadsheetId() {
  return `mock-spreadsheet-${++seq}-${Date.now()}`
}

function setup(sheets?: Record<string, (string | number | boolean | null)[][]>) {
  const spreadsheetId = newSpreadsheetId()
  api.createSpreadsheet(spreadsheetId, { sheets })
  const { doc, jwt } = useWorksheetWithServiceAccount(spreadsheetId, serviceAccount)
  return { spreadsheetId, doc, jwt }
}

// HTTP client errors (e.g. AxiosError) carry functions that AVA cannot serialize between processes,
// so rethrow them as plain errors keeping only the message
async function plain<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise
  } catch (e) {
    throw new Error((e as Error).message)
  }
}

function requestsFor(spreadsheetId: string) {
  return api.sheetsRequests().filter((r) => r.path.includes(`/v4/spreadsheets/${spreadsheetId}`))
}

// ---------------------------------------------------------------------------
// useWorksheetWithServiceAccount / useWorksheetWithServiceAccountFile
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'TABLES_SHEET_ID',
  'GOOGLE_APPLICATION_CREDENTIALS_JSON',
  'GOOGLE_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
]

async function withEnv(env: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const key of ENV_KEYS) delete process.env[key]
  Object.assign(process.env, env)
  try {
    await fn()
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

test.serial('useWorksheetWithServiceAccount: requires a spreadsheet id', async (t) => {
  await withEnv({}, () => {
    t.throws(() => useWorksheetWithServiceAccount(undefined, serviceAccount), {
      message: 'spreadsheetId or env.TABLES_SHEET_ID is required',
    })
  })
})

test.serial('useWorksheetWithServiceAccount: requires credentials', async (t) => {
  await withEnv({}, () => {
    t.throws(() => useWorksheetWithServiceAccount('sheet-id'), {
      message: 'serviceAccount or env.GOOGLE_APPLICATION_CREDENTIALS_JSON is required',
    })
  })
})

test.serial('useWorksheetWithServiceAccount: explicit arguments', (t) => {
  const { doc, jwt } = useWorksheetWithServiceAccount('explicit-id', serviceAccount)
  t.is(doc.spreadsheetId, 'explicit-id')
  t.is(jwt.email, account.client_email)
  t.is(jwt.key, account.private_key)
  t.deepEqual(jwt.scopes, [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file',
  ])
})

test.serial(
  'useWorksheetWithServiceAccount: env.TABLES_SHEET_ID and env.GOOGLE_APPLICATION_CREDENTIALS_JSON',
  async (t) => {
    await withEnv(
      {
        TABLES_SHEET_ID: 'env-sheet-id',
        GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify({ type: 'service_account', ...serviceAccount }),
      },
      () => {
        const { doc, jwt } = useWorksheetWithServiceAccount()
        t.is(doc.spreadsheetId, 'env-sheet-id')
        t.is(jwt.email, account.client_email)
        t.is(jwt.key, account.private_key)
      },
    )
  },
)

test.serial('useWorksheetWithServiceAccount: env.GOOGLE_SERVICE_ACCOUNT_EMAIL and PRIVATE_KEY', async (t) => {
  await withEnv(
    {
      TABLES_SHEET_ID: 'env-sheet-id',
      GOOGLE_SERVICE_ACCOUNT_EMAIL: 'other@mock-project.iam.gserviceaccount.com',
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: account.private_key,
    },
    () => {
      const { jwt } = useWorksheetWithServiceAccount()
      t.is(jwt.email, 'other@mock-project.iam.gserviceaccount.com')
      t.is(jwt.key, account.private_key)
    },
  )
})

test.serial('useWorksheetWithServiceAccountFile: reads the service account JSON file', async (t) => {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'gst-'))
  const file = Path.join(dir, 'service-account.json')
  Fs.writeFileSync(file, JSON.stringify({ type: 'service_account', ...serviceAccount }))
  try {
    const { doc, jwt } = useWorksheetWithServiceAccountFile('file-sheet-id', file)
    t.is(doc.spreadsheetId, 'file-sheet-id')
    t.is(jwt.email, account.client_email)

    await withEnv({ GOOGLE_APPLICATION_CREDENTIALS: file, TABLES_SHEET_ID: 'env-sheet-id' }, () => {
      const fromEnv = useWorksheetWithServiceAccountFile()
      t.is(fromEnv.doc.spreadsheetId, 'env-sheet-id')
      t.is(fromEnv.jwt.email, account.client_email)
    })
  } finally {
    Fs.rmSync(dir, { recursive: true, force: true })
  }
})

test.serial('useWorksheetWithServiceAccountFile: missing file throws', async (t) => {
  await withEnv({}, () => {
    t.throws(() => useWorksheetWithServiceAccountFile('id', Path.join(Os.tmpdir(), 'no-such-dir-gst', 'sa.json')), {
      code: 'ENOENT',
    })
  })
})

// ---------------------------------------------------------------------------
// Authentication against the mocked token endpoint
// ---------------------------------------------------------------------------

test('auth: obtains an access token with a signed JWT and sends it as Bearer', async (t) => {
  const { spreadsheetId, doc } = setup()
  const tokensBefore = api.issuedTokens.size

  await useSpreadsheetTable(doc, 'Docs', dataSchema)

  t.true(api.issuedTokens.size > tokensBefore, 'a token should be issued')
  const requests = requestsFor(spreadsheetId)
  t.true(requests.length > 0)
  for (const request of requests) {
    const authorization = String(request.headers['authorization'])
    t.regex(authorization, /^Bearer ya29\.mock-token-\d+$/)
    const token = authorization.replace('Bearer ', '')
    const issued = api.issuedTokens.get(token)
    t.is(issued?.email, account.client_email)
    t.true(issued?.scope.split(' ').includes('https://www.googleapis.com/auth/spreadsheets'))
    t.true(issued?.scope.split(' ').includes('https://www.googleapis.com/auth/drive.file'))
  }
})

test('auth: a key that does not match the registered service account is rejected', async (t) => {
  const spreadsheetId = newSpreadsheetId()
  api.createSpreadsheet(spreadsheetId)
  const impostor = generateServiceAccount()
  const { doc } = useWorksheetWithServiceAccount(spreadsheetId, {
    client_email: account.client_email,
    private_key: impostor.private_key,
  })

  await t.throwsAsync(plain(useSpreadsheetTable(doc, 'Docs', dataSchema)))
  t.true(api.tokenRequests().length > 0, 'a token should have been requested')
  t.is(requestsFor(spreadsheetId).length, 0, 'no Sheets API call should be made without a token')
})

// ---------------------------------------------------------------------------
// useSpreadsheetTable: worksheet / header handling
// ---------------------------------------------------------------------------

test('useSpreadsheetTable: creates the worksheet with a header row when missing', async (t) => {
  const { spreadsheetId, doc } = setup()

  const { sheet } = await useSpreadsheetTable(doc, 'Docs', dataSchema)

  t.is(sheet.title, 'Docs')
  t.deepEqual(api.sheetTitles(spreadsheetId), ['Sheet1', 'Docs'])
  t.deepEqual(api.values(spreadsheetId, 'Docs'), [['number', 'string']])
})

test('useSpreadsheetTable: uses an existing worksheet whose header contains all schema columns', async (t) => {
  const { spreadsheetId, doc } = setup({
    Docs: [
      ['string', 'extra', 'number'],
      ['one', 'x', 1],
    ],
  })

  const { snapshot } = await useSpreadsheetTable(doc, 'Docs', dataSchema)
  const { documents, errors } = await snapshot()

  t.deepEqual(api.sheetTitles(spreadsheetId), ['Docs'], 'no worksheet should be added')
  t.deepEqual(errors, [])
  t.deepEqual(documents, [{ rowKey: 2, data: { number: 1, string: 'one' } }])
})

test('useSpreadsheetTable: rejects an existing worksheet with missing columns', async (t) => {
  const { doc } = setup({ Docs: [['number', 'other']] })

  await t.throwsAsync(useSpreadsheetTable(doc, 'Docs', dataSchema), { message: 'Missing column(s): string' })
})

test('useSpreadsheetTable: rejects an existing worksheet without a header row', async (t) => {
  const { doc } = setup({ Docs: [] })

  await t.throwsAsync(useSpreadsheetTable(doc, 'Docs', dataSchema), { message: /header/i })
})

test('useSpreadsheetTable: surfaces Google API errors (spreadsheet not found)', async (t) => {
  const { doc } = useWorksheetWithServiceAccount('does-not-exist', serviceAccount)

  await t.throwsAsync(plain(useSpreadsheetTable(doc, 'Docs', dataSchema)), {
    message: /Requested entity was not found/,
  })
})

test('useSpreadsheetTable: surfaces Google API errors (permission denied)', async (t) => {
  const { spreadsheetId, doc } = setup()
  api.failNext((r) => r.path.includes(spreadsheetId), 403, 'PERMISSION_DENIED', 'The caller does not have permission')

  await t.throwsAsync(plain(useSpreadsheetTable(doc, 'Docs', dataSchema)), {
    message: /The caller does not have permission/,
  })
})

test('useDocumentsSheet is an alias of useSpreadsheetTable', (t) => {
  t.is(useDocumentsSheet, useSpreadsheetTable)
})

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

test('append / snapshot / get / patch / clear: full scenario', async (t) => {
  const { spreadsheetId, doc } = setup()
  const { snapshot, append, get, patch, clear } = await useSpreadsheetTable(doc, 'Docs', dataSchema)

  // Append documents
  t.deepEqual(await append({ number: 1, string: 'one' }), { rowKey: 2, data: { number: 1, string: 'one' } })
  t.deepEqual(await append({ number: 2, string: 'two' }), { rowKey: 3, data: { number: 2, string: 'two' } })
  t.deepEqual(api.values(spreadsheetId, 'Docs'), [
    ['number', 'string'],
    ['1', 'one'],
    ['2', 'two'],
  ])

  // Snapshot (values come back as formatted strings and are coerced by the schema)
  {
    const { documents, errors } = await snapshot()
    t.deepEqual(errors, [])
    t.deepEqual(documents, [
      { rowKey: 2, data: { number: 1, string: 'one' } },
      { rowKey: 3, data: { number: 2, string: 'two' } },
    ])
  }

  // Get a document
  t.deepEqual(await get(2), { rowKey: 2, data: { number: 1, string: 'one' } })
  t.deepEqual(await get(3), { rowKey: 3, data: { number: 2, string: 'two' } })

  // Patch documents
  await patch(2, { string: 'ONE' })
  await patch(3, { number: 3, string: 'THREE' })
  t.deepEqual(api.values(spreadsheetId, 'Docs'), [
    ['number', 'string'],
    ['1', 'ONE'],
    ['3', 'THREE'],
  ])
  {
    const { documents } = await snapshot()
    t.deepEqual(documents, [
      { rowKey: 2, data: { number: 1, string: 'ONE' } },
      { rowKey: 3, data: { number: 3, string: 'THREE' } },
    ])
  }

  // Clear all documents (header is kept)
  await clear()
  t.deepEqual(api.values(spreadsheetId, 'Docs'), [['number', 'string']])
  t.deepEqual((await snapshot()).documents, [])

  // Append again starts right below the header
  t.deepEqual(await append({ number: 1, string: 'one' }), { rowKey: 2, data: { number: 1, string: 'one' } })

  // Another instance on the existing worksheet sees the same data
  const another = await useSpreadsheetTable(doc, 'Docs', dataSchema)
  t.deepEqual((await another.snapshot()).documents, [{ rowKey: 2, data: { number: 1, string: 'one' } }])
  t.deepEqual(api.sheetTitles(spreadsheetId), ['Sheet1', 'Docs'])
})

test('snapshot: rows that do not match the schema are reported as errors', async (t) => {
  const { doc } = setup({
    Docs: [
      ['number', 'string'],
      [1, 'one'],
      ['not a number', 'two'],
      [3, 'three'],
    ],
  })
  const { snapshot } = await useSpreadsheetTable(doc, 'Docs', dataSchema)

  const { documents, errors } = await snapshot()
  t.deepEqual(
    documents.map((d) => d.rowKey),
    [2, 4],
  )
  t.is(errors.length, 1)
  t.regex(errors[0].message, /^#3 doesn't match dataSchema/)
})

test('snapshot: empty worksheet returns no documents', async (t) => {
  const { doc } = setup({ Docs: [['number', 'string']] })
  const { snapshot } = await useSpreadsheetTable(doc, 'Docs', dataSchema)

  t.deepEqual(await snapshot(), { documents: [], errors: [] })
})

test('get: returns null for a row that does not exist', async (t) => {
  const { doc } = setup({
    Docs: [
      ['number', 'string'],
      [1, 'one'],
    ],
  })
  const { get } = await useSpreadsheetTable(doc, 'Docs', dataSchema)

  t.is(await get(3), null)
  t.is(await get(100), null)
})

test('get: throws when the row does not match the schema', async (t) => {
  const { doc } = setup({
    Docs: [
      ['number', 'string'],
      ['NaN?', 'one'],
    ],
  })
  const { get } = await useSpreadsheetTable(doc, 'Docs', dataSchema)

  await t.throwsAsync(get(2), { message: /^#2 doesn't match dataSchema/ })
})

test('patch: throws when the row does not exist', async (t) => {
  const { doc } = setup({
    Docs: [
      ['number', 'string'],
      [1, 'one'],
    ],
  })
  const { patch } = await useSpreadsheetTable(doc, 'Docs', dataSchema)

  await t.throwsAsync(patch(5, { string: 'five' }), { message: 'Row 5 not found' })
})

test('patch: rejects invalid data without writing', async (t) => {
  const { spreadsheetId, doc } = setup({
    Docs: [
      ['number', 'string'],
      [1, 'one'],
    ],
  })
  const { patch } = await useSpreadsheetTable(doc, 'Docs', dataSchema)
  const writesBefore = requestsFor(spreadsheetId).filter((r) => r.method !== 'GET').length

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await t.throwsAsync(patch(2, { string: 123 as any }), { message: /^The data doesn't match dataSchema/ })

  t.is(requestsFor(spreadsheetId).filter((r) => r.method !== 'GET').length, writesBefore)
  t.deepEqual(api.values(spreadsheetId, 'Docs')[1], ['1', 'one'])
})

test('append: rejects invalid data without writing', async (t) => {
  const { spreadsheetId, doc } = setup({ Docs: [['number', 'string']] })
  const { append } = await useSpreadsheetTable(doc, 'Docs', dataSchema)
  const writesBefore = requestsFor(spreadsheetId).filter((r) => r.method !== 'GET').length

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await t.throwsAsync(append({ number: 1 } as any), { message: /^The data doesn't match dataSchema/ })

  t.is(requestsFor(spreadsheetId).filter((r) => r.method !== 'GET').length, writesBefore)
  t.deepEqual(api.values(spreadsheetId, 'Docs'), [['number', 'string']])
})

test('append: writes values in header order regardless of the object key order', async (t) => {
  const { spreadsheetId, doc } = setup({
    Docs: [
      ['string', 'number'],
      ['zero', 0],
    ],
  })
  const { append } = await useSpreadsheetTable(doc, 'Docs', dataSchema)

  const appended = await append({ number: 1, string: 'one' })

  t.is(appended.rowKey, 3)
  t.deepEqual(api.values(spreadsheetId, 'Docs'), [
    ['string', 'number'],
    ['zero', '0'],
    ['one', '1'],
  ])
})

test('append: surfaces Google API errors', async (t) => {
  const { spreadsheetId, doc } = setup({ Docs: [['number', 'string']] })
  const { append } = await useSpreadsheetTable(doc, 'Docs', dataSchema)
  api.failNext(
    (r) => r.path.includes(spreadsheetId) && r.path.includes(':append'),
    429,
    'RESOURCE_EXHAUSTED',
    "Quota exceeded for quota metric 'Write requests' and limit 'Write requests per minute per user'",
  )

  await t.throwsAsync(plain(append({ number: 1, string: 'one' })), { message: /Quota exceeded/ })
  t.deepEqual(api.values(spreadsheetId, 'Docs'), [['number', 'string']])
})

test('worksheet titles with quotes and spaces are handled', async (t) => {
  const { spreadsheetId, doc } = setup()
  const title = "Bob's table 2024"
  const { append, snapshot } = await useSpreadsheetTable(doc, title, dataSchema)

  await append({ number: 1, string: 'one' })

  t.deepEqual(api.values(spreadsheetId, title), [
    ['number', 'string'],
    ['1', 'one'],
  ])
  t.deepEqual((await snapshot()).documents, [{ rowKey: 2, data: { number: 1, string: 'one' } }])
})
