import { json } from '@sveltejs/kit';
import { listTrashed } from '$lib/server/core.js';

// Liste les sessions à la corbeille (transcripts déplacés dans <projet>/bin/).
export function GET() {
  return json({ trashed: listTrashed() });
}
