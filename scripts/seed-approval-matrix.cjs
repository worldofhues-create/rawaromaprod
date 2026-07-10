/* #4 — reproducible seed for iam.approval_matrix (the governance approval-routing reference).
 * Was seeded once via an ad-hoc script; this is the permanent, idempotent version (seeds only when
 * the table is empty, so it never duplicates). Included in `pnpm db:provision`. NOTE: the matrix's
 * authorities (Purchase Manager / Procurement Head / Finance Manager …) are finer-grained than the
 * system's 10 RBAC roles; concrete enforcement today is per-permission RBAC + segregation-of-duties
 * (creator≠approver) + the PR/PO state-machine guards + the auto-approval rule. Full authority→role
 * routing needs a business-defined mapping (Phase-2).
 * Run: DATABASE_URL=... node scripts/seed-approval-matrix.cjs */
const postgres = require('postgres');
const ROWS = [
  {
    "ord": 1,
    "module": "Stock Planning",
    "transaction": "Stock Requirement",
    "created_by": "Store Executive",
    "submitted_to": "Purchase Manager",
    "approved_by": "Purchase Manager",
    "final_authority": "Purchase Head",
    "auto_approval": "No",
    "remarks": "Based on reorder level/manual planning"
  },
  {
    "ord": 2,
    "module": "Procurement",
    "transaction": "Purchase Request (PR)",
    "created_by": "Purchase Executive / Store Executive",
    "submitted_to": "Purchase Manager",
    "approved_by": "Purchase Manager",
    "final_authority": "Procurement Head (if required)",
    "auto_approval": "No",
    "remarks": "Creator cannot approve own PR"
  },
  {
    "ord": 3,
    "module": "Procurement",
    "transaction": "RFQ Creation",
    "created_by": "Purchase Executive",
    "submitted_to": "Purchase Manager",
    "approved_by": "Purchase Manager",
    "final_authority": "-",
    "auto_approval": "No",
    "remarks": "RFQ must be approved before vendor dispatch"
  },
  {
    "ord": 4,
    "module": "Procurement",
    "transaction": "Vendor Quotation Evaluation",
    "created_by": "Purchase Executive",
    "submitted_to": "Purchase Manager",
    "approved_by": "Purchase Manager",
    "final_authority": "Procurement Head",
    "auto_approval": "No",
    "remarks": "Recommended vendor selection"
  },
  {
    "ord": 5,
    "module": "Procurement",
    "transaction": "Purchase Order (PO)",
    "created_by": "Purchase Executive",
    "submitted_to": "Purchase Manager",
    "approved_by": "Procurement Head",
    "final_authority": "Finance (if amount exceeds limit)",
    "auto_approval": "Configurable (24 hrs)",
    "remarks": "Approval based on value"
  },
  {
    "ord": 6,
    "module": "Procurement",
    "transaction": "Advance Payment Request",
    "created_by": "Purchase Executive",
    "submitted_to": "Accounts Executive",
    "approved_by": "Finance Manager",
    "final_authority": "CFO / Owner",
    "auto_approval": "No",
    "remarks": "Before vendor payment"
  },
  {
    "ord": 7,
    "module": "Procurement",
    "transaction": "Vendor Credit Note",
    "created_by": "Accounts Executive",
    "submitted_to": "Finance Manager",
    "approved_by": "Finance Manager",
    "final_authority": "Finance Head",
    "auto_approval": "No",
    "remarks": "Generated after QC failure"
  },
  {
    "ord": 8,
    "module": "Procurement",
    "transaction": "Replacement Purchase Order",
    "created_by": "Purchase Executive",
    "submitted_to": "Purchase Manager",
    "approved_by": "Procurement Head",
    "final_authority": "Finance",
    "auto_approval": "No",
    "remarks": "Linked to failed batch"
  },
  {
    "ord": 9,
    "module": "Gate Entry",
    "transaction": "Gate Entry",
    "created_by": "Security",
    "submitted_to": "Store Executive",
    "approved_by": "Store Manager",
    "final_authority": "-",
    "auto_approval": "Yes",
    "remarks": "Operational approval"
  },
  {
    "ord": 10,
    "module": "GRN",
    "transaction": "Goods Receipt (GRN)",
    "created_by": "Store Executive",
    "submitted_to": "Store Manager",
    "approved_by": "Store Manager",
    "final_authority": "-",
    "auto_approval": "No",
    "remarks": "Quantity verification"
  },
  {
    "ord": 11,
    "module": "Quality Control",
    "transaction": "Quantity Verification",
    "created_by": "Store Executive",
    "submitted_to": "Store Manager",
    "approved_by": "Store Manager",
    "final_authority": "-",
    "auto_approval": "No",
    "remarks": "Before QC sampling"
  },
  {
    "ord": 12,
    "module": "Quality Control",
    "transaction": "Quality Inspection",
    "created_by": "QC Executive",
    "submitted_to": "QC Manager",
    "approved_by": "QC Manager",
    "final_authority": "Technical Head (optional)",
    "auto_approval": "No",
    "remarks": "PASS / HOLD / FAIL"
  },
  {
    "ord": 13,
    "module": "Inventory",
    "transaction": "Material Masking",
    "created_by": "System / Formula Custodian",
    "submitted_to": "-",
    "approved_by": "Formula Owner",
    "final_authority": "-",
    "auto_approval": "Automatic",
    "remarks": "Alias assignment after QC PASS"
  },
  {
    "ord": 14,
    "module": "Inventory",
    "transaction": "Rack Allocation",
    "created_by": "Store Executive",
    "submitted_to": "Store Manager",
    "approved_by": "Store Manager",
    "final_authority": "-",
    "auto_approval": "No",
    "remarks": "QC-approved inventory only"
  },
  {
    "ord": 15,
    "module": "Formula Vault",
    "transaction": "Formula Creation",
    "created_by": "Formula Owner",
    "submitted_to": "Technical Head",
    "approved_by": "Technical Head",
    "final_authority": "Business Owner",
    "auto_approval": "No",
    "remarks": "Draft to Approved"
  },
  {
    "ord": 16,
    "module": "Formula Vault",
    "transaction": "Formula Revision",
    "created_by": "Formula Owner",
    "submitted_to": "Technical Head",
    "approved_by": "Technical Head",
    "final_authority": "Business Owner",
    "auto_approval": "No",
    "remarks": "Version controlled"
  },
  {
    "ord": 17,
    "module": "Formula Vault",
    "transaction": "Formula Access Request",
    "created_by": "Authorized User",
    "submitted_to": "Formula Owner",
    "approved_by": "Formula Owner",
    "final_authority": "Business Owner",
    "auto_approval": "No",
    "remarks": "Restricted access"
  },
  {
    "ord": 18,
    "module": "Production",
    "transaction": "Production Plan",
    "created_by": "Production Planner",
    "submitted_to": "Production Manager",
    "approved_by": "Production Manager",
    "final_authority": "Plant Head",
    "auto_approval": "No",
    "remarks": "Production scheduling"
  },
  {
    "ord": 19,
    "module": "Production",
    "transaction": "Production Order",
    "created_by": "Production Planner",
    "submitted_to": "Production Manager",
    "approved_by": "Production Manager",
    "final_authority": "Plant Head",
    "auto_approval": "No",
    "remarks": "Based on approved formula"
  },
  {
    "ord": 20,
    "module": "Production",
    "transaction": "Material Issue",
    "created_by": "Store Executive",
    "submitted_to": "Production Supervisor",
    "approved_by": "Production Supervisor",
    "final_authority": "-",
    "auto_approval": "No",
    "remarks": "Against approved pick list"
  },
  {
    "ord": 21,
    "module": "Production",
    "transaction": "Secure Mixing Session",
    "created_by": "Production Operator",
    "submitted_to": "Production Supervisor",
    "approved_by": "Production Supervisor",
    "final_authority": "-",
    "auto_approval": "Automatic",
    "remarks": "Session audit trail"
  },
  {
    "ord": 22,
    "module": "Production",
    "transaction": "Oil Batch Release",
    "created_by": "Production Supervisor",
    "submitted_to": "QC Manager",
    "approved_by": "QC Manager",
    "final_authority": "Technical Head",
    "auto_approval": "No",
    "remarks": "After production QC"
  },
  {
    "ord": 23,
    "module": "Production",
    "transaction": "Failed Batch Approval",
    "created_by": "QC Manager",
    "submitted_to": "Technical Head",
    "approved_by": "Technical Head",
    "final_authority": "Business Owner",
    "auto_approval": "No",
    "remarks": "Reject / Rework decision"
  },
  {
    "ord": 24,
    "module": "Packaging",
    "transaction": "Packaging Order",
    "created_by": "Packaging Planner",
    "submitted_to": "Packaging Manager",
    "approved_by": "Packaging Manager",
    "final_authority": "Production Head",
    "auto_approval": "No",
    "remarks": "Triggered after QC PASS"
  },
  {
    "ord": 25,
    "module": "Packaging",
    "transaction": "Packaging Material Issue",
    "created_by": "Store Executive",
    "submitted_to": "Packaging Supervisor",
    "approved_by": "Packaging Supervisor",
    "final_authority": "-",
    "auto_approval": "No",
    "remarks": "Bottle, cap, label etc."
  },
  {
    "ord": 26,
    "module": "Packaging",
    "transaction": "Finished Goods Release",
    "created_by": "Packaging Supervisor",
    "submitted_to": "QC Manager",
    "approved_by": "QC Manager",
    "final_authority": "Warehouse Manager",
    "auto_approval": "No",
    "remarks": "After packaging QC"
  },
  {
    "ord": 27,
    "module": "Sales",
    "transaction": "Sales Order",
    "created_by": "Sales Executive",
    "submitted_to": "Sales Manager",
    "approved_by": "Sales Manager",
    "final_authority": "Business Head",
    "auto_approval": "No",
    "remarks": "Customer order"
  },
  {
    "ord": 28,
    "module": "Sales",
    "transaction": "Sales Discount",
    "created_by": "Sales Executive",
    "submitted_to": "Sales Manager",
    "approved_by": "Sales Manager",
    "final_authority": "Business Head",
    "auto_approval": "No",
    "remarks": "Discount approval matrix"
  },
  {
    "ord": 29,
    "module": "Dispatch",
    "transaction": "Dispatch Order",
    "created_by": "Dispatch Executive",
    "submitted_to": "Warehouse Manager",
    "approved_by": "Warehouse Manager",
    "final_authority": "Logistics Head",
    "auto_approval": "No",
    "remarks": "Dispatch authorization"
  },
  {
    "ord": 30,
    "module": "Dispatch",
    "transaction": "Dispatch Confirmation",
    "created_by": "Dispatch Executive",
    "submitted_to": "Sales Manager",
    "approved_by": "Sales Manager",
    "final_authority": "-",
    "auto_approval": "Automatic",
    "remarks": "Customer dispatch completed"
  },
  {
    "ord": 31,
    "module": "Returns",
    "transaction": "Sales Return",
    "created_by": "Customer Service",
    "submitted_to": "Sales Manager",
    "approved_by": "QC Manager",
    "final_authority": "Finance Manager",
    "auto_approval": "No",
    "remarks": "Return approval"
  },
  {
    "ord": 32,
    "module": "Complaint",
    "transaction": "Customer Complaint",
    "created_by": "Customer Service",
    "submitted_to": "QC Manager",
    "approved_by": "Technical Head",
    "final_authority": "Business Owner",
    "auto_approval": "No",
    "remarks": "Root cause analysis"
  },
  {
    "ord": 33,
    "module": "Workflow",
    "transaction": "Workflow Change",
    "created_by": "System Administrator",
    "submitted_to": "IT Manager",
    "approved_by": "IT Manager",
    "final_authority": "Business Owner",
    "auto_approval": "No",
    "remarks": "Workflow governance"
  },
  {
    "ord": 34,
    "module": "User & Security",
    "transaction": "User Creation",
    "created_by": "HR / Admin",
    "submitted_to": "IT Administrator",
    "approved_by": "System Administrator",
    "final_authority": "Business Owner",
    "auto_approval": "No",
    "remarks": "New user onboarding"
  },
  {
    "ord": 35,
    "module": "User & Security",
    "transaction": "Role Assignment",
    "created_by": "System Administrator",
    "submitted_to": "IT Manager",
    "approved_by": "IT Manager",
    "final_authority": "Business Owner",
    "auto_approval": "No",
    "remarks": "RBAC control"
  }
];
(async () => {
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  await sql.unsafe(`create table if not exists iam.approval_matrix (
    approval_matrix_id uuid primary key default gen_random_uuid(),
    ord integer, module text, transaction text, created_by text, submitted_to text,
    approved_by text, final_authority text, auto_approval text, remarks text,
    status varchar(20) default 'ACTIVE',
    created_dt timestamptz not null default now(), updated_dt timestamptz not null default now(),
    created_by_user varchar(64), updated_by_user varchar(64))`);
  const n = (await sql`select count(*)::int c from iam.approval_matrix`)[0].c;
  if (n === 0) {
    for (const r of ROWS) {
      await sql`insert into iam.approval_matrix (ord, module, transaction, created_by, submitted_to, approved_by, final_authority, auto_approval, remarks, status)
        values (${r.ord}, ${r.module}, ${r.transaction}, ${r.created_by}, ${r.submitted_to}, ${r.approved_by}, ${r.final_authority}, ${r.auto_approval}, ${r.remarks}, 'ACTIVE')`;
    }
    console.log('approval_matrix seeded:', ROWS.length, 'rows');
  } else {
    console.log('approval_matrix already has', n, 'rows — skipping seed.');
  }
  await sql.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
