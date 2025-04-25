import test from 'ava'
import { config } from 'dotenv'
import { v4 } from 'uuid'
import { z } from 'zod'

import { useDocumentsSheet, useWorksheetWithServiceAccount } from './index.js'

config()

test('Testing', async (t) => {
  const { doc } = useWorksheetWithServiceAccount()
  const worksheetName = v4()
  const dataSchema = z.object({
    number: z.coerce.number(),
    string: z.string(),
  })
  const { sheet, snapshot, append, get, patch, clear } = await useDocumentsSheet(doc, worksheetName, dataSchema)

  // Append documents
  await append({ number: 1, string: 'one' })
  await append({ number: 2, string: 'two' })

  // Get documents
  {
    const { documents, errors } = await snapshot()
    t.is(documents.length, 2, `Appended first 2 documents: Documents count should be 2`)
    t.is(errors.length, 0, `Appended first 2 documents: Errors count should be 0`)

    t.is(documents[0].rowKey, 2, `Appended first 2 documents: First document rowKey should be 2`)
    t.is(documents[0].data.number, 1, `Appended first 2 documents: First document number should be 1`)
    t.is(documents[0].data.string, 'one', `Appended first 2 documents: First document string should be 'one'`)
    t.is(documents[1].rowKey, 3, `Appended first 2 documents: Second document rowKey should be 3`)
    t.is(documents[1].data.number, 2, `Appended first 2 documents: Second document number should be 2`)
    t.is(documents[1].data.string, 'two', `Appended first 2 documents: Second document string should be 'two'`)
  }

  // Get a document
  {
    const document = await get(2)
    t.not(document, null, `Get document #2: Document should not be null`)
    t.is(document!.rowKey, 2, `Get document #2: Document rowKey should be 2`)
    t.is(document!.data.number, 1, `Get document #2: Document number should be 1`)
    t.is(document!.data.string, 'one', `Get document #2: Document string should be 'one'`)
  }

  // Patch a document
  await patch(2, { string: 'ONE' })
  await patch(3, { number: 3, string: 'THREE' })

  {
    const { documents } = await snapshot()
    t.is(documents.length, 2, `Patch document #2: Documents count should be 2`)
    t.is(documents[0].rowKey, 2, `Patch document #2: First document rowKey should be 2`)
    t.is(documents[0].data.number, 1, `Patch document #2: First document number should be 1`)
    t.is(documents[0].data.string, 'ONE', `Patch document #2: First document string should be 'ONE'`)
    t.is(documents[1].rowKey, 3, `Patch document #2: Second document rowKey should be 3`)
    t.is(documents[1].data.number, 3, `Patch document #2: Second document number should be 3`)
    t.is(documents[1].data.string, 'THREE', `Patch document #2: Second document string should be 'THREE'`)
  }

  // Clear all documents
  await clear()
  {
    const { documents } = await snapshot()
    t.is(documents.length, 0, `Clear all documents: Documents count should be 0`)
  }

  // Append document again
  await append({ number: 1, string: 'one' })
  {
    const { documents } = await snapshot()
    t.is(documents.length, 1, `Append document again: Documents count should be 1`)
    t.is(documents[0].rowKey, 2, `Append document again: First document rowKey should be 2`)
    t.is(documents[0].data.number, 1, `Append document again: First document number should be 1`)
    t.is(documents[0].data.string, 'one', `Append document again: First document string should be 'one'`)
  }

  await sheet.delete()
})
