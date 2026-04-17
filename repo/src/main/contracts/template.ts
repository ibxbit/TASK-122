import type { Database } from 'better-sqlite3';

/* =========================================================================
 * Contract Template Engine
 *
 *   • Declarative variable schema (per template row) validated with
 *     min/max/enum — zero dependencies, no full JSON-Schema runtime.
 *   • Rendering substitutes two placeholder forms:
 *        {{var:name}}      → value from instance variables
 *        {{clause:code}}   → body of contract_clauses (may itself contain {{var:...}})
 *   • Clauses are resolved first, then variables — so a clause can reference
 *     variables defined on the instance.
 * ========================================================================= */

export type VariableType = 'integer' | 'number' | 'string' | 'enum' | 'boolean' | 'date';

export interface VariableSpec {
  name:         string;
  type:         VariableType;
  required?:    boolean;
  min?:         number;                    // integer / number
  max?:         number;
  values?:      string[];                  // enum
  description?: string;
}

export interface TemplateVariablesSchema {
  variables: VariableSpec[];
}

export interface ValidationIssue {
  field:   string;
  code:    string;
  message: string;
}

/** Baseline lease template — matches the product spec exactly. */
export const DEFAULT_LEASE_VARIABLES: TemplateVariablesSchema = {
  variables: [
    { name: 'leaseTerm',    type: 'integer', required: true, min: 1,   max: 36,    description: 'Lease term in months' },
    { name: 'rent',         type: 'number',  required: true, min: 500, max: 50000, description: 'Rent amount'           },
    { name: 'paymentCycle', type: 'enum',    required: true, values: ['monthly','quarterly'], description: 'Payment cycle' },
  ],
};

export function validateVariables(
  schema: TemplateVariablesSchema,
  values: Record<string, unknown>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const spec of schema.variables) {
    const v = values[spec.name];
    const missing = v === undefined || v === null || v === '';

    if (missing) {
      if (spec.required) issues.push({ field: spec.name, code: 'required', message: `${spec.name} is required` });
      continue;
    }

    switch (spec.type) {
      case 'integer': {
        if (!Number.isInteger(v)) {
          issues.push({ field: spec.name, code: 'type', message: `${spec.name} must be an integer` });
          break;
        }
        const n = v as number;
        if (spec.min !== undefined && n < spec.min) issues.push({ field: spec.name, code: 'min', message: `${spec.name} must be ≥ ${spec.min}` });
        if (spec.max !== undefined && n > spec.max) issues.push({ field: spec.name, code: 'max', message: `${spec.name} must be ≤ ${spec.max}` });
        break;
      }
      case 'number': {
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          issues.push({ field: spec.name, code: 'type', message: `${spec.name} must be a number` });
          break;
        }
        if (spec.min !== undefined && v < spec.min) issues.push({ field: spec.name, code: 'min', message: `${spec.name} must be ≥ ${spec.min}` });
        if (spec.max !== undefined && v > spec.max) issues.push({ field: spec.name, code: 'max', message: `${spec.name} must be ≤ ${spec.max}` });
        break;
      }
      case 'enum': {
        if (!spec.values || !spec.values.includes(String(v))) {
          issues.push({ field: spec.name, code: 'enum', message: `${spec.name} must be one of: ${(spec.values ?? []).join(', ')}` });
        }
        break;
      }
      case 'string':  if (typeof v !== 'string')  issues.push({ field: spec.name, code: 'type', message: `${spec.name} must be a string` });  break;
      case 'boolean': if (typeof v !== 'boolean') issues.push({ field: spec.name, code: 'type', message: `${spec.name} must be boolean` }); break;
      case 'date': {
        if (typeof v !== 'number' && typeof v !== 'string') {
          issues.push({ field: spec.name, code: 'type', message: `${spec.name} must be a date (unix seconds or ISO-8601 string)` });
        }
        break;
      }
    }
  }
  return issues;
}

/* --- Rendering ------------------------------------------------------- */

export interface RenderResult {
  body:           string;
  appliedClauses: Array<{ code: string; title: string }>;
  missing:        string[];                // unresolved variable / clause refs
}

export interface RenderInput {
  tenantId:  string;
  body:      string;                        // with {{var:x}} / {{clause:y}}
  variables: Record<string, unknown>;
}

const VAR_RE    = /\{\{\s*var\s*:\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const CLAUSE_RE = /\{\{\s*clause\s*:\s*([a-zA-Z0-9_\-]+)\s*\}\}/g;

export function renderTemplate(db: Database, input: RenderInput): RenderResult {
  const appliedClauses: Array<{ code: string; title: string }> = [];
  const missing: string[] = [];

  // 1. Inline clauses (may contain further {{var:…}} placeholders).
  const withClauses = input.body.replace(CLAUSE_RE, (_match, code: string) => {
    const row = db.prepare(`
      SELECT code, title, body FROM contract_clauses
       WHERE tenant_id = ? AND code = ? AND active = 1
    `).get(input.tenantId, code) as { code: string; title: string; body: string } | undefined;

    if (!row) { missing.push(`clause:${code}`); return `[[MISSING CLAUSE: ${code}]]`; }
    appliedClauses.push({ code: row.code, title: row.title });
    return row.body;
  });

  // 2. Substitute variables.
  const body = withClauses.replace(VAR_RE, (_match, name: string) => {
    const v = input.variables[name];
    if (v === undefined || v === null) { missing.push(`var:${name}`); return `[[UNDEFINED: ${name}]]`; }
    return String(v);
  });

  return { body, appliedClauses, missing };
}
