// In-process modality hints (Model C).
//
// The upload route probes a PDF's text layer cheaply at upload time and records
// the predicted modality here. When the doc is later processed via
// POST /api/documents/:docId/process WITHOUT an explicit modality in the body,
// the route consults this hint so the parse starts with the right adapter,
// skipping the digital->0-blocks->MinerU retry detour.
//
// Deliberately memory-only: losing hints across restart just falls back to the
// existing digital-first attempt + OCR auto-retry, i.e. pre-hint behavior. No
// persistence complexity for a ~200ms saving.

const hints = new Map<string, 'digital' | 'scanned'>();

export function setModalityHint(docId: string, modality: 'digital' | 'scanned'): void {
  if (!docId) return;
  hints.set(docId, modality);
}

/** Peek the hint without consuming it. */
export function getModalityHint(docId: string): 'digital' | 'scanned' | undefined {
  return hints.get(docId);
}

export function deleteModalityHint(docId: string): void {
  hints.delete(docId);
}
