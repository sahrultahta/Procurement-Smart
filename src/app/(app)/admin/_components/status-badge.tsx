import { Badge } from '@/components/ui/badge';

export function UserStatusBadge({ status, passwordSet }: { status: 'active' | 'deactivated'; passwordSet: boolean }) {
  if (status === 'deactivated') return <Badge variant="destructive">Deactivated</Badge>;
  if (!passwordSet) return <Badge variant="outline">Pending setup</Badge>;
  return <Badge variant="secondary">Active</Badge>;
}

export function ErrorPanel({ message }: { message: string }) {
  return (
    <div role="alert" className="rounded-md border border-destructive/50 p-4 text-sm text-destructive">
      {message}
    </div>
  );
}
