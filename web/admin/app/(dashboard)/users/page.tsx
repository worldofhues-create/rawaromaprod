'use client';

import * as React from 'react';
import { Badge, DataTable, type ColumnDef } from '@core/ui';

/**
 * Sample admin page demonstrating the reusable @core/ui <DataTable/>.
 *
 * DATA-TABLE REUSE MODEL: the table component is fully generic (no domain types). The
 * APP owns the row shape (`UserRow`) and the typed `columns`, then hands them to the
 * generic table, which provides sorting, pagination, and row selection for free. The same
 * component renders a finance ledger or an ops queue in another app — only columns differ.
 */
interface UserRow {
  id: string;
  name: string;
  email: string;
  role: string;
  verified: boolean;
  createdAt: string;
}

const ROWS: UserRow[] = [
  { id: 'u_01', name: 'Aarav Sharma', email: 'aarav@example.com', role: 'admin', verified: true, createdAt: '2026-01-12' },
  { id: 'u_02', name: 'Diya Patel', email: 'diya@example.com', role: 'ops', verified: true, createdAt: '2026-02-03' },
  { id: 'u_03', name: 'Kabir Rao', email: 'kabir@example.com', role: 'finance', verified: false, createdAt: '2026-02-20' },
  { id: 'u_04', name: 'Meera Nair', email: 'meera@example.com', role: 'ops', verified: true, createdAt: '2026-03-09' },
  { id: 'u_05', name: 'Rohan Gupta', email: 'rohan@example.com', role: 'admin', verified: false, createdAt: '2026-03-28' },
  { id: 'u_06', name: 'Sana Khan', email: 'sana@example.com', role: 'finance', verified: true, createdAt: '2026-04-15' },
  { id: 'u_07', name: 'Vikram Iyer', email: 'vikram@example.com', role: 'ops', verified: true, createdAt: '2026-05-01' },
  { id: 'u_08', name: 'Zoya Ahmed', email: 'zoya@example.com', role: 'admin', verified: false, createdAt: '2026-05-22' },
];

const columns: ColumnDef<UserRow>[] = [
  {
    id: 'name',
    header: 'Name',
    cell: (r) => <span className="font-medium">{r.name}</span>,
    sortable: true,
    sortAccessor: (r) => r.name,
  },
  { id: 'email', header: 'Email', cell: (r) => r.email, sortable: true, sortAccessor: (r) => r.email },
  {
    id: 'role',
    header: 'Role',
    cell: (r) => <Badge variant="neutral">{r.role}</Badge>,
    sortable: true,
    sortAccessor: (r) => r.role,
  },
  {
    id: 'verified',
    header: 'Status',
    cell: (r) =>
      r.verified ? <Badge variant="trust">Verified</Badge> : <Badge variant="warning">Pending</Badge>,
    sortable: true,
    sortAccessor: (r) => Number(r.verified),
  },
  {
    id: 'createdAt',
    header: 'Created',
    cell: (r) => <span className="text-text-muted">{r.createdAt}</span>,
    sortable: true,
    sortAccessor: (r) => r.createdAt,
  },
];

export default function UsersPage() {
  const [selected, setSelected] = React.useState<string[]>([]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Users</h1>
          <p className="text-sm text-text-muted">
            Sample table — sortable, paginated, selectable. {selected.length} selected.
          </p>
        </div>
      </div>

      <DataTable
        data={ROWS}
        columns={columns}
        getRowId={(r) => r.id}
        pageSize={5}
        enableSelection
        onSelectionChange={setSelected}
      />
    </div>
  );
}
