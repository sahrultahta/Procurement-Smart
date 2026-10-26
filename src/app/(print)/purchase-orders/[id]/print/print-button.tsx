'use client';

import { Button } from '@/components/ui/button';

/** Opens the browser's print dialog (PDF output is the browser's "Save as PDF"; v1 renders no PDF itself). */
export function PrintButton() {
  return (
    <Button type="button" onClick={() => window.print()}>
      Print
    </Button>
  );
}
