'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** A one-time setup link: shown once, never stored by the page. */
export function SetupLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-2 rounded-md border border-dashed p-3" data-testid="setup-link">
      <p className="text-sm">
        One-time password setup link. It works once and expires in 24 hours. Send it to the user through a channel you trust; it
        will not be shown again.
      </p>
      <div className="flex gap-2">
        <Input readOnly value={url} aria-label="Setup link" onFocus={(e) => e.currentTarget.select()} />
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(url).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}
