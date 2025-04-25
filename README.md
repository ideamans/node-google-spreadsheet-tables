[日本語版はこちら](./README.ja.md)

# Google Spreadsheet Tables

A TypeScript library that enables using Google Spreadsheets as a simple database with type safety. It provides a type-safe interface using Zod schemas to define table structures and perform CRUD operations on Google Spreadsheets.

For small-scale, non-critical applications where performance is not a primary concern, Google Spreadsheets can serve as an excellent database alternative. This library provides a programming interface that makes it easy to view and manipulate data while maintaining type safety through Zod schemas.

## Installation

1. Create a service account in Google Cloud Platform (GCP)
2. Download the service account JSON key (e.g. `./service-account.json`)
3. Share your Google Spreadsheet with the service account email address:
   - Open your Google Spreadsheet
   - Click the "Share" button
   - Add the service account email address (found in the `client_email` field of your JSON key)
   - Set the permission to "Editor"
4. Install the package:

```bash
pnpm add google-spreadsheet-tables
```

## Usage Example

Here's a complete example of how to use the library with a user profile schema:

```typescript
import { useWorksheetWithServiceAccountFile, useDocumentsSheet } from 'google-spreadsheet-tables'
import { z } from 'zod'

// Define your schema
const userSchema = z.object({
  name: z.string(),
  age: z.coerce.number(),
  gender: z.enum(['male', 'female', 'other']),
  company: z.string().optional(),
})

// Initialize the spreadsheet connection
// Replace 'YOUR_SPREADSHEET_ID' to your file id. e.g. 1vob8zYwa2p9mLDaczN_Egn-01QjC-tC80-Y83yYMCR0
const { doc } = useWorksheetWithServiceAccountFile('YOUR_SPREADSHEET_ID', './service-account.json')

// Create a documents sheet
const { append, get, patch, snapshot, clear } = await useDocumentsSheet(
  doc,
  'Users',
  userSchema
)

// Add a new user
const newUser = await append({
  name: 'John Doe',
  age: 30,
  gender: 'male',
  company: 'Acme Inc.'
})

// Get all users
const { documents: allUsers } = await snapshot()

// Get a specific user
const user = await get(newUser.rowKey)

// Update a user
await patch(newUser.rowKey, {
  age: 31,
  company: 'New Company'
})

// Clear all users
await clear()
```

## Service Account Credentials

There are two ways to provide service account credentials:

### 1. Using Environment Variable for File Path

Set the `GOOGLE_APPLICATION_CREDENTIALS` environment variable to point to your service account JSON file:

```bash
export GOOGLE_APPLICATION_CREDENTIALS="./service-account.json"
```

Then you can use `useWorksheetWithServiceAccountFile` without specifying the file path:

```typescript
const { doc } = useWorksheetWithServiceAccountFile('YOUR_SPREADSHEET_ID')
```

### 2. Using Environment Variable for JSON Content

Alternatively, you can set the `GOOGLE_APPLICATION_CREDENTIALS_JSON` environment variable with the actual JSON content:

```bash
export GOOGLE_APPLICATION_CREDENTIALS_JSON='{"client_email":"...","private_key":"..."}'
```

Then you can use `useWorksheetWithServiceAccount` without specifying the service account:

```typescript
const { doc } = useWorksheetWithServiceAccount('YOUR_SPREADSHEET_ID')
```

### 3. Using Individual Environment Variables

You can also set individual environment variables for the service account credentials:

```bash
export GOOGLE_SERVICE_ACCOUNT_EMAIL="your-service-account@project.iam.gserviceaccount.com"
export GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."
```

Then you can use `useWorksheetWithServiceAccount` without specifying the service account:

```typescript
const { doc } = useWorksheetWithServiceAccount('YOUR_SPREADSHEET_ID')
```

## API Reference

### `useWorksheetWithServiceAccount(spreadsheetId?: string, serviceAccount?: ServiceAccount)`

Initializes a connection to a Google Spreadsheet using a service account.

- `spreadsheetId`: The ID of the Google Spreadsheet
- `serviceAccount`: Service account credentials (client_email and private_key)

### `useWorksheetWithServiceAccountFile(spreadsheetId?: string, filePath?: string)`

Initializes a connection to a Google Spreadsheet using a service account JSON file.

- `spreadsheetId`: The ID of the Google Spreadsheet
- `filePath`: Path to the service account JSON file

### `useDocumentsSheet(doc: GoogleSpreadsheet, worksheetName: string, dataSchema: z.ZodObject<z.ZodRawShape>)`

Creates a documents sheet with the specified schema.

Returns an object with the following methods:

- `append(data: DataType)`: Adds a new document
- `get(rowKey: number)`: Retrieves a document by row number
- `patch(rowKey: number, data: PartialType)`: Updates a document
- `snapshot()`: Retrieves all documents
- `clear()`: Removes all documents
- `documentSchema`: The complete document schema
- `partialSchema`: The partial document schema for updates
- `sheet`: The underlying Google Spreadsheet worksheet

## Environment Variables

The library can use the following environment variables:

- `TABLES_SHEET_ID`: The default spreadsheet ID
- `GOOGLE_APPLICATION_CREDENTIALS_JSON`: Service account credentials as a JSON string
- `GOOGLE_APPLICATION_CREDENTIALS`: Path to the service account JSON file
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`: Service account email address
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`: Service account private key
