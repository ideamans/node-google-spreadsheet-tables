import Fs from 'fs'

import { JWT } from 'google-auth-library'
import { GoogleSpreadsheet } from 'google-spreadsheet'
import { z } from 'zod'

export interface ServiceAccount {
  client_email: string
  private_key: string
}

// Use google-spreadsheet instance with service account
export function useWorksheetWithServiceAccount(spreadsheetId?: string, serviceAccount?: ServiceAccount) {
  spreadsheetId = spreadsheetId || process.env.TABLES_SHEET_ID
  if (!spreadsheetId) {
    throw new Error('spreadsheetId or env.TABLES_SHEET_ID is required')
  }
  if (!serviceAccount) {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
      serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) as ServiceAccount
    } else {
      throw new Error(`serviceAccount or env.GOOGLE_APPLICATION_CREDENTIALS_JSON is required`)
    }
  }

  const jwt = new JWT({
    email: serviceAccount.client_email,
    key: serviceAccount.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'],
  })

  const doc = new GoogleSpreadsheet(spreadsheetId, jwt)

  return { jwt, doc }
}

// Use google-spreadsheet instance with
export function useWorksheetWithServiceAccountFile(spreadsheetId?: string, filePath?: string) {
  filePath = filePath || process.env.GOOGLE_APPLICATION_CREDENTIALS || './service-account.json'
  if (!filePath) {
    throw new Error('filePath or env.GOOGLE_APPLICATION_CREDENTIALS is required')
  }

  const json = Fs.readFileSync(filePath, 'utf-8')
  const serviceAccount = JSON.parse(json) as ServiceAccount
  return useWorksheetWithServiceAccount(spreadsheetId, serviceAccount)
}

// Use worksheet as documents database with spreadsheet and zod schema
export async function useDocumentsSheet(
  doc: GoogleSpreadsheet,
  worksheetName: string,
  dataSchema: z.ZodObject<z.ZodRawShape>,
) {
  // Detect the sheet
  await doc.loadInfo()
  let sheet = doc.sheetsByTitle[worksheetName]
  if (sheet) {
    // Validate header columns with schema
    const headerColumns = [...sheet.headerValues].sort()
    const schemaColumns = [...Object.keys(dataSchema.shape)].sort()
    if (
      headerColumns.length !== schemaColumns.length ||
      headerColumns.some((column) => !schemaColumns.includes(column))
    ) {
      throw new Error(`Headers in ${worksheetName} doesn't match dataSchema`)
    }
  } else {
    // Add the worksheet
    sheet = await doc.addSheet({ title: worksheetName })
    await sheet.setHeaderRow(Object.keys(dataSchema.shape))
  }

  // Data type
  type DataType = z.infer<typeof dataSchema>

  // Document schema
  const documentSchema = z.object({
    rowKey: z.number().describe('Row number key'),
    data: dataSchema.describe('Data body'),
  })
  type DocumentType = z.infer<typeof documentSchema>

  // Partial schema
  const partialSchema = dataSchema.partial()
  type PartialType = z.infer<typeof partialSchema>

  // Snapshot of all documents
  async function snapshot(): Promise<{ documents: DocumentType[]; errors: Error[] }> {
    const rows = await sheet.getRows()
    const errors: Error[] = []

    const documents: DocumentType[] = []
    for (const row of rows) {
      // Validate the row
      const asObject = row.toObject()
      const validation = dataSchema.safeParse(asObject)
      if (!validation.success) {
        errors.push(new Error(`#${row.rowNumber} doesn't match dataSchema: ${validation.error.message}`))
        continue
      }

      documents.push({
        rowKey: row.rowNumber,
        data: validation.data,
      })
    }

    return {
      documents,
      errors,
    }
  }

  // Get a document by row number key
  async function get(rowKey: number): Promise<DocumentType | null> {
    const rows = await sheet.getRows({ offset: rowKey - 2, limit: 1 })
    const record = rows[0]
    if (!record) {
      return null
    }

    const asObject = record.toObject()
    const validation = dataSchema.safeParse(asObject)
    if (!validation.success) {
      throw new Error(`#${rowKey} doesn't match dataSchema: ${validation.error.message}`)
    }

    return {
      rowKey: record.rowNumber,
      data: validation.data,
    }
  }

  // Update a document by row number key
  async function patch(rowKey: number, data: PartialType) {
    const rows = await sheet.getRows({ offset: rowKey - 2, limit: 1 })
    const record = rows[0]
    if (!record) {
      throw new Error(`Row ${rowKey} not found`)
    }

    const validation = partialSchema.safeParse(data)
    if (!validation.success) {
      throw new Error(`The data doesn't match dataSchema: ${validation.error.message}: ${JSON.stringify(data)}`)
    }

    record.assign(validation.data)
    await record.save()
  }

  // Clear all documents
  async function clear(): Promise<void> {
    await sheet.clearRows()
  }

  // Append a new document
  async function append(data: DataType): Promise<DocumentType> {
    const validation = dataSchema.safeParse(data)
    if (!validation.success) {
      throw new Error(`The data doesn't match dataSchema: ${validation.error.message}: ${JSON.stringify(data)}`)
    }
    const row = await sheet.addRow(data)

    return {
      rowKey: row.rowNumber,
      data: validation.data,
    }
  }

  return {
    documentSchema,
    partialSchema,
    sheet,
    snapshot,
    get,
    patch,
    clear,
    append,
  }
}
