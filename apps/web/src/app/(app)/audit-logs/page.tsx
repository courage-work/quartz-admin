import type { Metadata } from 'next';

import { AuditLogsView } from './audit-logs-view';

export const metadata: Metadata = { title: '감사 로그' };

export default function AuditLogsPage() {
  return <AuditLogsView />;
}
