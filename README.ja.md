[English version is here](./README.md)

# Google Spreadsheet Tables

Google スプレッドシートを型安全なデータベースとして利用するための TypeScript ライブラリです。Zod スキーマを使用してテーブル構造を定義し、Google スプレッドシート上で CRUD 操作を実行できます。

小規模でクリティカルでない要件や、性能が重要でないデータベースとして、Google スプレッドシートは優れた代替手段となります。このライブラリは、Zod スキーマによる型安全性を保ちながら、データの閲覧と操作を容易にするプログラミングインターフェースを提供します。

## インストール

1. Google Cloud Platform (GCP) でサービスアカウントを作成
2. サービスアカウントの JSON 鍵をダウンロード（例：`./service-account.json`）
3. Google スプレッドシートをサービスアカウントのメールアドレスと共有：
   - Google スプレッドシートを開く
   - 「共有」ボタンをクリック
   - サービスアカウントのメールアドレスを追加（JSON 鍵の `client_email` フィールドに記載）
   - 権限を「編集者」に設定
4. パッケージをインストール：

```bash
pnpm add google-spreadsheet-tables
```

## 使用例

以下は、ユーザープロファイルスキーマを使用した完全な使用例です：

```typescript
import { useWorksheetWithServiceAccountFile, useDocumentsSheet } from 'google-spreadsheet-tables'
import { z } from 'zod'

// スキーマを定義
const userSchema = z.object({
  name: z.string(),
  age: z.coerce.number(),
  gender: z.enum(['male', 'female', 'other']),
  company: z.string().optional(),
})

// スプレッドシート接続を初期化
// 'YOUR_SPREADSHEET_ID' を実際のファイルIDに置き換えてください。例：1vob8zYwa2p9mLDaczN_Egn-01QjC-tC80-Y83yYMCR0
const { doc } = useWorksheetWithServiceAccountFile('YOUR_SPREADSHEET_ID', './service-account.json')

// ドキュメントシートを作成
const { append, get, patch, snapshot, clear } = await useDocumentsSheet(
  doc,
  'Users',
  userSchema
)

// 新しいユーザーを追加
const newUser = await append({
  name: 'John Doe',
  age: 30,
  gender: 'male',
  company: 'Acme Inc.'
})

// すべてのユーザーを取得
const { documents: allUsers } = await snapshot()

// 特定のユーザーを取得
const user = await get(newUser.rowKey)

// ユーザーを更新
await patch(newUser.rowKey, {
  age: 31,
  company: 'New Company'
})

// すべてのユーザーを削除
await clear()
```

## サービスアカウント認証情報

サービスアカウントの認証情報を提供する方法は2つあります：

### 1. 環境変数でファイルパスを指定

`GOOGLE_APPLICATION_CREDENTIALS` 環境変数にサービスアカウントの JSON ファイルのパスを設定します：

```bash
export GOOGLE_APPLICATION_CREDENTIALS="./service-account.json"
```

その後、`useWorksheetWithServiceAccountFile` をファイルパスを指定せずに使用できます：

```typescript
const { doc } = useWorksheetWithServiceAccountFile('YOUR_SPREADSHEET_ID')
```

### 2. 環境変数で JSON コンテンツを指定

または、`GOOGLE_APPLICATION_CREDENTIALS_JSON` 環境変数に実際の JSON コンテンツを設定することもできます：

```bash
export GOOGLE_APPLICATION_CREDENTIALS_JSON='{"client_email":"...","private_key":"..."}'
```

その後、`useWorksheetWithServiceAccount` をサービスアカウントを指定せずに使用できます：

```typescript
const { doc } = useWorksheetWithServiceAccount('YOUR_SPREADSHEET_ID')
```

## API リファレンス

### `useWorksheetWithServiceAccount(spreadsheetId?: string, serviceAccount?: ServiceAccount)`

サービスアカウントを使用して Google スプレッドシートへの接続を初期化します。

- `spreadsheetId`: Google スプレッドシートの ID
- `serviceAccount`: サービスアカウントの認証情報（client_email と private_key）

### `useWorksheetWithServiceAccountFile(spreadsheetId?: string, filePath?: string)`

サービスアカウントの JSON ファイルを使用して Google スプレッドシートへの接続を初期化します。

- `spreadsheetId`: Google スプレッドシートの ID
- `filePath`: サービスアカウントの JSON ファイルのパス

### `useDocumentsSheet(doc: GoogleSpreadsheet, worksheetName: string, dataSchema: z.ZodObject<z.ZodRawShape>)`

指定されたスキーマでドキュメントシートを作成します。

以下のメソッドを持つオブジェクトを返します：

- `append(data: DataType)`: 新しいドキュメントを追加
- `get(rowKey: number)`: 行番号でドキュメントを取得
- `patch(rowKey: number, data: PartialType)`: ドキュメントを更新
- `snapshot()`: すべてのドキュメントを取得
- `clear()`: すべてのドキュメントを削除
- `documentSchema`: 完全なドキュメントスキーマ
- `partialSchema`: 更新用の部分的なドキュメントスキーマ
- `sheet`: 基盤となる Google スプレッドシートのワークシート

## 環境変数

ライブラリは以下の環境変数を使用できます：

- `DOCUMENTS_SHEET_ID`: デフォルトのスプレッドシート ID
- `GOOGLE_APPLICATION_CREDENTIALS_JSON`: サービスアカウントの認証情報（JSON 文字列）
- `GOOGLE_APPLICATION_CREDENTIALS`: サービスアカウントの JSON ファイルのパス
