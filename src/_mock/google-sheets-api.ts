// In-memory emulation of the Google Sheets API v4 (and the OAuth2 token endpoint)
// at the HTTP level, built on nock.
//
// The mock intercepts HTTP requests (both node:http and fetch) to the real Google
// hostnames, so it does not depend on the internals of google-spreadsheet or
// google-auth-library and keeps working when those libraries are upgraded.
//
// Response shapes follow the Sheets API v4 reference:
//   https://developers.google.com/sheets/api/reference/rest
// Only the subset used by google-spreadsheet for row based access is emulated.

import Crypto from 'crypto'

import nock from 'nock'

const SHEETS_ORIGIN = 'https://sheets.googleapis.com'
const TOKEN_ENDPOINTS = [
  { origin: 'https://oauth2.googleapis.com', path: '/token' },
  { origin: 'https://www.googleapis.com', path: '/oauth2/v4/token' },
]

const DEFAULT_ROW_COUNT = 1000
const DEFAULT_COLUMN_COUNT = 26

export type CellValue = string | number | boolean | null | undefined

export interface RecordedRequest {
  method: string
  host: string
  path: string
  headers: Record<string, string | string[] | undefined>
  body: unknown
}

interface MockSheet {
  sheetId: number
  title: string
  index: number
  rowCount: number
  columnCount: number
  // Values are kept as Google returns them with the default FORMATTED_VALUE rendering: strings
  cells: string[][]
}

interface MockSpreadsheet {
  spreadsheetId: string
  title: string
  sheets: MockSheet[]
  nextSheetId: number
}

interface GridRange {
  sheet: MockSheet
  startRow: number // 0-based inclusive
  endRow: number // 0-based inclusive
  startColumn: number
  endColumn: number
}

interface MockResponse {
  status: number
  body: unknown
}

class ApiError extends Error {
  constructor(
    public code: number,
    public status: string,
    message: string,
  ) {
    super(message)
  }
}

// Google style error body
function errorBody(code: number, status: string, message: string) {
  return { error: { code, message, status } }
}

export function columnToLetter(column: number): string {
  // column is 1-based
  let letter = ''
  let n = column
  while (n > 0) {
    const mod = (n - 1) % 26
    letter = String.fromCharCode(65 + mod) + letter
    n = (n - mod - 1) / 26
  }
  return letter
}

function letterToColumn(letter: string): number {
  let column = 0
  for (const char of letter) {
    column = column * 26 + (char.charCodeAt(0) - 64)
  }
  return column
}

function quoteSheetTitle(title: string): string {
  return /^[A-Za-z0-9_]+$/.test(title) ? title : `'${title.replace(/'/g, "''")}'`
}

function formatValue(value: unknown): string {
  // USER_ENTERED values are rendered back as formatted strings
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  return String(value)
}

function headersToObject(headers: Headers): RecordedRequest['headers'] {
  const result: RecordedRequest['headers'] = {}
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value
  })
  return result
}

// Response bodies omit trailing empty cells
function trimRow(row: string[]): string[] {
  const trimmed = [...row]
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop()
  return trimmed
}

function decodeBase64Url(segment: string): Buffer {
  return Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

function parseFormBody(body: unknown): Record<string, string> {
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
    return body as Record<string, string>
  }
  const text = Buffer.isBuffer(body) ? body.toString('utf-8') : String(body ?? '')
  return Object.fromEntries(new URLSearchParams(text))
}

function parseJsonBody(body: unknown): unknown {
  if (body === undefined || body === null || body === '') return undefined
  if (typeof body === 'string') {
    try {
      return JSON.parse(body)
    } catch {
      return body
    }
  }
  return body
}

export interface ServiceAccountKeyPair {
  client_email: string
  private_key: string
  public_key: string
}

// Generate a throwaway service account whose private key can sign JWT assertions
export function generateServiceAccount(email = 'tester@mock-project.iam.gserviceaccount.com'): ServiceAccountKeyPair {
  const { privateKey, publicKey } = Crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  return { client_email: email, private_key: privateKey, public_key: publicKey }
}

export class MockGoogleSheetsApi {
  readonly requests: RecordedRequest[] = []
  readonly issuedTokens = new Map<string, { email: string; scope: string }>()
  private readonly spreadsheets = new Map<string, MockSpreadsheet>()
  private readonly publicKeys = new Map<string, string>()
  private readonly injectedFailures: { match: (r: RecordedRequest) => boolean; response: MockResponse }[] = []
  private tokenSeq = 0

  // ---- Setup helpers ----

  registerServiceAccount(account: { client_email: string; public_key: string }) {
    this.publicKeys.set(account.client_email, account.public_key)
  }

  createSpreadsheet(spreadsheetId: string, options: { title?: string; sheets?: Record<string, CellValue[][]> } = {}) {
    const spreadsheet: MockSpreadsheet = {
      spreadsheetId,
      title: options.title ?? 'Mock Spreadsheet',
      sheets: [],
      nextSheetId: 0,
    }
    this.spreadsheets.set(spreadsheetId, spreadsheet)
    const sheets = options.sheets ?? { Sheet1: [] }
    for (const [title, rows] of Object.entries(sheets)) {
      const sheet = this.addSheet(spreadsheet, { title })
      sheet.cells = rows.map((row) => row.map(formatValue))
    }
    return spreadsheet
  }

  // Current values of a sheet with trailing empty cells / rows trimmed, as the API would return them
  values(spreadsheetId: string, title: string): string[][] {
    const sheet = this.findSheet(this.getSpreadsheet(spreadsheetId), title)
    if (!sheet) throw new Error(`No sheet ${title}`)
    return this.readRange({
      sheet,
      startRow: 0,
      endRow: sheet.rowCount - 1,
      startColumn: 0,
      endColumn: sheet.columnCount - 1,
    })
  }

  sheetTitles(spreadsheetId: string): string[] {
    return this.getSpreadsheet(spreadsheetId).sheets.map((s) => s.title)
  }

  // Make the next request matching the predicate fail with a Google style error
  failNext(match: (r: RecordedRequest) => boolean, code: number, status: string, message: string) {
    this.injectedFailures.push({ match, response: { status: code, body: errorBody(code, status, message) } })
  }

  sheetsRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.host === SHEETS_ORIGIN)
  }

  tokenRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.host !== SHEETS_ORIGIN)
  }

  // ---- nock lifecycle ----

  install() {
    nock.disableNetConnect()
    const json = (res: MockResponse) =>
      [res.status, JSON.stringify(res.body), { 'Content-Type': 'application/json; charset=UTF-8' }] as const

    // nock (>= 14) passes the intercepted request to reply functions as a WHATWG Request.
    // Keep the reply functions single-argument: nock treats two-argument functions as callback style.
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      nock(SHEETS_ORIGIN)
        .persist()
        .intercept(/.*/, method)
        .reply(async (request: Request) => {
          const url = new URL(request.url)
          const body = await request.text()
          return json(this.handleSheets(method, url.pathname + url.search, headersToObject(request.headers), body))
        })
    }

    for (const endpoint of TOKEN_ENDPOINTS) {
      nock(endpoint.origin)
        .persist()
        .post(endpoint.path)
        .reply(async (request: Request) => {
          const url = new URL(request.url)
          const body = await request.text()
          return json(
            this.handleToken(endpoint.origin + endpoint.path, url.pathname, headersToObject(request.headers), body),
          )
        })
    }
  }

  static uninstall() {
    nock.cleanAll()
    nock.enableNetConnect()
  }

  // ---- OAuth2 token endpoint (JWT bearer grant used by service accounts) ----

  private handleToken(audience: string, uri: string, headers: RecordedRequest['headers'], rawBody: unknown) {
    const form = parseFormBody(rawBody)
    const recorded: RecordedRequest = { method: 'POST', host: audience, path: uri, headers, body: form }
    this.requests.push(recorded)

    const failure = this.takeFailure(recorded)
    if (failure) return failure

    const invalid = (description: string): MockResponse => ({
      status: 400,
      body: { error: 'invalid_grant', error_description: description },
    })

    if (form.grant_type !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
      return { status: 400, body: { error: 'unsupported_grant_type', error_description: 'Invalid grant_type: ' } }
    }
    const segments = (form.assertion ?? '').split('.')
    if (segments.length !== 3)
      return invalid('Invalid JWT: Token must be a short-lived token and in a reasonable timeframe')

    let claims: { iss?: string; scope?: string; aud?: string; exp?: number; iat?: number }
    try {
      claims = JSON.parse(decodeBase64Url(segments[1]).toString('utf-8'))
    } catch {
      return invalid('Invalid JWT: malformed payload')
    }
    const publicKey = claims.iss ? this.publicKeys.get(claims.iss) : undefined
    if (!publicKey) return invalid('Invalid grant: account not found')

    const verified = Crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${segments[0]}.${segments[1]}`),
      publicKey,
      decodeBase64Url(segments[2]),
    )
    if (!verified) return invalid('Invalid JWT Signature.')

    const accessToken = `ya29.mock-token-${++this.tokenSeq}`
    this.issuedTokens.set(accessToken, { email: claims.iss!, scope: claims.scope ?? '' })
    return {
      status: 200,
      body: { access_token: accessToken, expires_in: 3599, token_type: 'Bearer' },
    }
  }

  // ---- Sheets API v4 ----

  private handleSheets(method: string, uri: string, headers: RecordedRequest['headers'], rawBody: unknown) {
    const body = parseJsonBody(rawBody)
    const recorded: RecordedRequest = { method, host: SHEETS_ORIGIN, path: uri, headers, body }
    this.requests.push(recorded)

    const failure = this.takeFailure(recorded)
    if (failure) return failure

    try {
      this.authenticate(headers)
      return { status: 200, body: this.route(method, uri, body) }
    } catch (e) {
      if (e instanceof ApiError) return { status: e.code, body: errorBody(e.code, e.status, e.message) }
      throw e
    }
  }

  private takeFailure(recorded: RecordedRequest): MockResponse | undefined {
    const index = this.injectedFailures.findIndex((f) => f.match(recorded))
    if (index < 0) return undefined
    const [failure] = this.injectedFailures.splice(index, 1)
    return failure.response
  }

  private authenticate(headers: RecordedRequest['headers']) {
    const raw = headers['authorization']
    const authorization = Array.isArray(raw) ? raw[0] : raw
    const token = authorization?.match(/^Bearer (.+)$/)?.[1]
    if (!token) {
      throw new ApiError(
        401,
        'UNAUTHENTICATED',
        'Request is missing required authentication credential. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.',
      )
    }
    const issued = this.issuedTokens.get(token)
    if (!issued) {
      throw new ApiError(
        401,
        'UNAUTHENTICATED',
        'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.',
      )
    }
    if (!issued.scope.split(' ').includes('https://www.googleapis.com/auth/spreadsheets')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Request had insufficient authentication scopes.')
    }
  }

  private route(method: string, uri: string, body: unknown): unknown {
    const url = new URL(uri, SHEETS_ORIGIN)
    const match = url.pathname.match(/^\/v4\/spreadsheets\/([^/:]+)(.*)$/)
    if (!match) throw new ApiError(404, 'NOT_FOUND', 'Requested entity was not found.')

    const spreadsheet = this.spreadsheets.get(decodeURIComponent(match[1]))
    if (!spreadsheet) throw new ApiError(404, 'NOT_FOUND', 'Requested entity was not found.')

    // Clients joining a base URL may send "/{id}/:batchUpdate"; the API accepts both forms
    const rest = match[2].startsWith('/:') ? match[2].slice(1) : match[2]
    const query = url.searchParams

    if (method === 'GET' && (rest === '' || rest === '/')) {
      return this.spreadsheetResource(spreadsheet)
    }
    if (method === 'POST' && rest === ':batchUpdate') {
      return this.batchUpdate(spreadsheet, body as { requests?: Record<string, unknown>[] })
    }
    if (method === 'GET' && rest === '/values:batchGet') {
      const ranges = query.getAll('ranges')
      return {
        spreadsheetId: spreadsheet.spreadsheetId,
        valueRanges: ranges.map((range) => this.valueRange(this.parseRange(spreadsheet, range))),
      }
    }

    const valuesMatch = rest.match(/^\/values\/(.+?)(:append|:clear)?$/)
    if (valuesMatch) {
      const range = this.parseRange(spreadsheet, decodeURIComponent(valuesMatch[1]))
      const action = valuesMatch[2]
      if (method === 'GET' && !action) return this.valueRange(range)
      if (method === 'PUT' && !action) return this.updateValues(spreadsheet, range, body, query)
      if (method === 'POST' && action === ':append') return this.appendValues(spreadsheet, range, body, query)
      if (method === 'POST' && action === ':clear') return this.clearValues(spreadsheet, range)
    }

    throw new ApiError(404, 'NOT_FOUND', `Mock does not emulate ${method} ${url.pathname}`)
  }

  // ---- Resources ----

  private getSpreadsheet(spreadsheetId: string): MockSpreadsheet {
    const spreadsheet = this.spreadsheets.get(spreadsheetId)
    if (!spreadsheet) throw new Error(`No spreadsheet ${spreadsheetId}`)
    return spreadsheet
  }

  private findSheet(spreadsheet: MockSpreadsheet, title: string): MockSheet | undefined {
    return spreadsheet.sheets.find((s) => s.title === title)
  }

  private sheetProperties(sheet: MockSheet) {
    return {
      sheetId: sheet.sheetId,
      title: sheet.title,
      index: sheet.index,
      sheetType: 'GRID',
      gridProperties: { rowCount: sheet.rowCount, columnCount: sheet.columnCount },
    }
  }

  private spreadsheetResource(spreadsheet: MockSpreadsheet) {
    return {
      spreadsheetId: spreadsheet.spreadsheetId,
      properties: {
        title: spreadsheet.title,
        locale: 'en_US',
        autoRecalc: 'ON_CHANGE',
        timeZone: 'Asia/Tokyo',
        defaultFormat: {
          backgroundColor: { red: 1, green: 1, blue: 1 },
          verticalAlignment: 'BOTTOM',
          wrapStrategy: 'OVERFLOW_CELL',
          textFormat: { fontFamily: 'arial,sans,sans-serif', fontSize: 10 },
        },
      },
      sheets: spreadsheet.sheets.map((sheet) => ({ properties: this.sheetProperties(sheet) })),
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheet.spreadsheetId}/edit`,
    }
  }

  private addSheet(spreadsheet: MockSpreadsheet, properties: { title?: string; sheetId?: number; index?: number }) {
    const title = properties.title ?? `Sheet${spreadsheet.sheets.length + 1}`
    if (this.findSheet(spreadsheet, title)) {
      throw new ApiError(
        400,
        'INVALID_ARGUMENT',
        `Invalid requests[0].addSheet: A sheet with the name "${title}" already exists. Please enter another name.`,
      )
    }
    const sheet: MockSheet = {
      sheetId: properties.sheetId ?? spreadsheet.nextSheetId,
      title,
      index: spreadsheet.sheets.length,
      rowCount: DEFAULT_ROW_COUNT,
      columnCount: DEFAULT_COLUMN_COUNT,
      cells: [],
    }
    // Real sheet ids are random; keep them deterministic but non-sequential-looking
    spreadsheet.nextSheetId = sheet.sheetId === 0 ? 1_000_001 : spreadsheet.nextSheetId + 1
    spreadsheet.sheets.push(sheet)
    return sheet
  }

  private batchUpdate(spreadsheet: MockSpreadsheet, body: { requests?: Record<string, unknown>[] }) {
    const replies: Record<string, unknown>[] = []
    for (const request of body?.requests ?? []) {
      const [kind, payload] = Object.entries(request)[0] ?? []
      if (kind === 'addSheet') {
        const sheet = this.addSheet(spreadsheet, (payload as { properties?: { title?: string } }).properties ?? {})
        replies.push({ addSheet: { properties: this.sheetProperties(sheet) } })
      } else if (kind === 'deleteSheet') {
        const { sheetId } = payload as { sheetId: number }
        const index = spreadsheet.sheets.findIndex((s) => s.sheetId === sheetId)
        if (index < 0) {
          throw new ApiError(400, 'INVALID_ARGUMENT', `Invalid requests[0].deleteSheet: No sheet with id: ${sheetId}`)
        }
        spreadsheet.sheets.splice(index, 1)
        spreadsheet.sheets.forEach((s, i) => (s.index = i))
        replies.push({})
      } else {
        throw new ApiError(400, 'INVALID_ARGUMENT', `Mock does not emulate batchUpdate request "${kind}"`)
      }
    }
    return {
      spreadsheetId: spreadsheet.spreadsheetId,
      replies,
      updatedSpreadsheet: this.spreadsheetResource(spreadsheet),
    }
  }

  // ---- A1 notation ----

  private parseRange(spreadsheet: MockSpreadsheet, a1: string): GridRange {
    const unable = () => new ApiError(400, 'INVALID_ARGUMENT', `Unable to parse range: ${a1}`)

    let sheetPart: string | undefined
    let cellPart: string | undefined
    const quoted = a1.match(/^'((?:[^']|'')+)'(?:!(.*))?$/)
    if (quoted) {
      sheetPart = quoted[1].replace(/''/g, "'")
      cellPart = quoted[2]
    } else if (a1.includes('!')) {
      const i = a1.indexOf('!')
      sheetPart = a1.slice(0, i)
      cellPart = a1.slice(i + 1)
    } else {
      // Either a bare sheet title or a bare range on the first sheet
      if (this.findSheet(spreadsheet, a1)) sheetPart = a1
      else cellPart = a1
    }

    const sheet = sheetPart === undefined ? spreadsheet.sheets[0] : this.findSheet(spreadsheet, sheetPart)
    if (!sheet) throw unable()

    const whole: GridRange = {
      sheet,
      startRow: 0,
      endRow: sheet.rowCount - 1,
      startColumn: 0,
      endColumn: sheet.columnCount - 1,
    }
    if (!cellPart) return whole

    const [startRef, endRef] = cellPart.split(':')
    const parseRef = (ref: string) => {
      const m = ref.match(/^([A-Z]*)([0-9]*)$/)
      if (!m || (m[1] === '' && m[2] === '')) throw unable()
      return {
        column: m[1] ? letterToColumn(m[1]) - 1 : undefined,
        row: m[2] ? parseInt(m[2], 10) - 1 : undefined,
      }
    }
    const start = parseRef(startRef)
    const end = endRef === undefined ? start : parseRef(endRef)

    return {
      sheet,
      startRow: start.row ?? 0,
      endRow: end.row ?? (endRef === undefined ? (start.row ?? sheet.rowCount - 1) : sheet.rowCount - 1),
      startColumn: start.column ?? 0,
      endColumn: end.column ?? (endRef === undefined ? (start.column ?? sheet.columnCount - 1) : sheet.columnCount - 1),
    }
  }

  private formatRange(range: GridRange): string {
    return `${quoteSheetTitle(range.sheet.title)}!${columnToLetter(range.startColumn + 1)}${range.startRow + 1}:${columnToLetter(range.endColumn + 1)}${range.endRow + 1}`
  }

  // ---- Values ----

  private readRange(range: GridRange): string[][] {
    const rows: string[][] = []
    const lastRow = Math.min(range.endRow, range.sheet.rowCount - 1)
    for (let r = range.startRow; r <= lastRow; r++) {
      const source = range.sheet.cells[r] ?? []
      const row: string[] = []
      for (let c = range.startColumn; c <= range.endColumn; c++) row.push(source[c] ?? '')
      rows.push(trimRow(row))
    }
    // ...and trailing empty rows
    while (rows.length > 0 && rows[rows.length - 1].length === 0) rows.pop()
    return rows
  }

  private valueRange(range: GridRange) {
    const values = this.readRange(range)
    const lastRow = Math.min(range.endRow, range.sheet.rowCount - 1)
    // `values` is omitted entirely when the range is empty
    return {
      range: this.formatRange({ ...range, endRow: lastRow }),
      majorDimension: 'ROWS',
      ...(values.length > 0 && { values }),
    }
  }

  private writeRows(range: GridRange, values: unknown[][]) {
    const sheet = range.sheet
    const rowsNeeded = range.startRow + values.length
    if (rowsNeeded > sheet.rowCount) sheet.rowCount = rowsNeeded
    values.forEach((row, i) => {
      const r = range.startRow + i
      sheet.cells[r] = sheet.cells[r] ?? []
      row.forEach((value, j) => {
        sheet.cells[r][range.startColumn + j] = formatValue(value)
      })
    })
  }

  private checkValueInputOption(query: URLSearchParams) {
    const option = query.get('valueInputOption')
    if (option !== 'RAW' && option !== 'USER_ENTERED') {
      throw new ApiError(400, 'INVALID_ARGUMENT', "Invalid value at 'value_input_option'")
    }
  }

  private updateValues(spreadsheet: MockSpreadsheet, range: GridRange, body: unknown, query: URLSearchParams) {
    this.checkValueInputOption(query)
    const values = ((body as { values?: unknown[][] })?.values ?? []).map((row) => row ?? [])
    const width = Math.max(0, ...values.map((row) => row.length))
    if (range.startColumn + width - 1 > range.endColumn || values.length - 1 > range.endRow - range.startRow) {
      throw new ApiError(
        400,
        'INVALID_ARGUMENT',
        `Requested writing within range [${this.formatRange(range)}], but tried writing to a cell outside of it.`,
      )
    }
    this.writeRows(range, values)

    const written: GridRange = {
      ...range,
      endRow: range.startRow + values.length - 1,
      endColumn: range.startColumn + width - 1,
    }
    return {
      spreadsheetId: spreadsheet.spreadsheetId,
      updatedRange: this.formatRange(written),
      updatedRows: values.length,
      updatedColumns: width,
      updatedCells: values.reduce((sum, row) => sum + row.length, 0),
      ...(query.get('includeValuesInResponse') === 'true' && {
        updatedData: {
          range: this.formatRange(written),
          majorDimension: 'ROWS',
          values: values.map((row) => trimRow(row.map(formatValue))),
        },
      }),
    }
  }

  private appendValues(spreadsheet: MockSpreadsheet, range: GridRange, body: unknown, query: URLSearchParams) {
    this.checkValueInputOption(query)
    const values = ((body as { values?: unknown[][] })?.values ?? []).map((row) => row ?? [])
    const width = Math.max(0, ...values.map((row) => row.length))
    const sheet = range.sheet

    // Find the "table": the last non-empty row at or after the start of the given range
    let lastDataRow = range.startRow - 1
    for (let r = range.startRow; r < sheet.cells.length; r++) {
      if ((sheet.cells[r] ?? []).some((v) => v !== '')) lastDataRow = r
    }
    const tableRange: GridRange | undefined =
      lastDataRow >= range.startRow
        ? {
            ...range,
            endRow: lastDataRow,
            endColumn: Math.max(
              range.startColumn,
              ...sheet.cells.slice(range.startRow, lastDataRow + 1).map((row) => (row ?? []).length - 1),
            ),
          }
        : undefined

    const target: GridRange = {
      sheet,
      startRow: lastDataRow + 1,
      endRow: lastDataRow + values.length,
      startColumn: range.startColumn,
      endColumn: range.startColumn + width - 1,
    }
    if (query.get('insertDataOption') === 'INSERT_ROWS') {
      sheet.cells.splice(target.startRow, 0, ...values.map(() => [] as string[]))
      sheet.rowCount += values.length
    }
    this.writeRows(target, values)

    return {
      spreadsheetId: spreadsheet.spreadsheetId,
      ...(tableRange && { tableRange: this.formatRange(tableRange) }),
      updates: {
        spreadsheetId: spreadsheet.spreadsheetId,
        updatedRange: this.formatRange(target),
        updatedRows: values.length,
        updatedColumns: width,
        updatedCells: values.reduce((sum, row) => sum + row.length, 0),
        ...(query.get('includeValuesInResponse') === 'true' && {
          updatedData: {
            range: this.formatRange(target),
            majorDimension: 'ROWS',
            values: values.map((row) => trimRow(row.map(formatValue))),
          },
        }),
      },
    }
  }

  private clearValues(spreadsheet: MockSpreadsheet, range: GridRange) {
    const sheet = range.sheet
    for (let r = range.startRow; r <= Math.min(range.endRow, sheet.cells.length - 1); r++) {
      const row = sheet.cells[r]
      if (!row) continue
      for (let c = range.startColumn; c <= range.endColumn; c++) {
        if (c < row.length) row[c] = ''
      }
    }
    return { spreadsheetId: spreadsheet.spreadsheetId, clearedRange: this.formatRange(range) }
  }
}
