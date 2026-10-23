import type { Metadata } from 'next';
import { Card, CardContent } from '@/components/ui/card';
import { currencyCodes, getSettings, timeZones } from '@/modules/organization';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { SettingsForm } from '../_components/settings-form';
import { ErrorPanel } from '../_components/status-badge';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const result = await runQuery(await getRequestContext(), getSettings, {});
  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-semibold">Settings</h1>
      {!result.ok ? (
        <ErrorPanel message={result.error.message} />
      ) : (
        <Card>
          <CardContent>
            <SettingsForm settings={result.data} timeZones={timeZones()} currencies={currencyCodes()} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
