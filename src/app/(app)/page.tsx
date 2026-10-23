import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ROLE_LABELS } from '@/modules/identity';
import { getRequestContext } from '@/server/request-context';

export default async function HomePage() {
  const { actor } = await getRequestContext();
  if (!actor) return null; // the layout already redirects
  const roles = actor.roles.map((role) => ROLE_LABELS[role]);

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-semibold">ProcureFlow</h1>
        <p className="text-muted-foreground">Welcome, {actor.name}.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Your access</CardTitle>
          <CardDescription>
            {roles.length > 0 ? `Roles: ${roles.join(', ')}.` : 'You have no roles yet. Ask an administrator to assign one.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p>
            Available so far: suppliers (with maker-checker review) and requisition drafts. Submitting requisitions for approval
            arrives in the next phase; quotations, purchase orders, and receipts after that.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
