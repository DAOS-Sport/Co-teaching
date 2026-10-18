export class MetadataReadTimeout extends Error {
  readonly code = 'METADATA_READ_TIMEOUT';
  constructor() { super('METADATA_READ_TIMEOUT'); }
}

export class MetadataReadonlyRequired extends Error {
  readonly code = 'METADATA_READONLY_REQUIRED';
  constructor() { super('METADATA_READONLY_REQUIRED'); }
}

type Client = {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, any>> }>;
  release(destroy?: boolean): void;
};

// Driver options are intent, not evidence of the acquired session's state.
export async function requireReadonlyMetadataClient(client: Client): Promise<void> {
  const result = await client.query('SHOW transaction_read_only');
  if (result.rows[0]?.transaction_read_only !== 'on') {
    throw new MetadataReadonlyRequired();
  }
}

// Destroy the acquired connection on timeout, including a late acquisition.
// A rejected race alone would leave the database work running in the background.
export async function boundedMetadataQuery(
  connect: () => Promise<Client>, text: string, values: unknown[] = [], timeoutMs = 2500,
  preflight?: (client: Client) => Promise<void>,
) {
  let client: Client | undefined;
  let expired = false;
  let released = false;
  let timer: ReturnType<typeof setTimeout>;
  const release = (destroy: boolean) => {
    if (client && !released) { released = true; client.release(destroy); }
  };
  const work = (async () => {
    client = await connect();
    if (expired) { release(true); throw new MetadataReadTimeout(); }
    try {
      if (preflight) await preflight(client);
      if (expired) throw new MetadataReadTimeout();
      return await client.query(text, values);
    }
    catch (error) { release(true); throw error; }
    finally { release(expired); }
  })();
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { expired = true; release(true); reject(new MetadataReadTimeout()); }, timeoutMs);
  });
  try { return await Promise.race([work, deadline]); }
  finally { clearTimeout(timer!); }
}

const codeOf = (error: unknown) => (error as { code?: string })?.code;
export function createMetadataSnapshotReader(query: (text: string, values?: unknown[]) => Promise<{rows: Array<Record<string, any>>}>) {
  const read = async (text: string, missingCode: string, failureCode: string) => {
    try { return {status: 'ready' as const, rows: (await query(text)).rows}; }
    catch (error) {
      const code = codeOf(error);
      return {status: code === '42P01' ? 'not_connected' as const : 'error' as const, rows: [],
        code: code === '42P01' ? missingCode : code === 'METADATA_READONLY_REQUIRED' ? code : code === 'METADATA_READ_TIMEOUT' || code === '57014' ? 'METADATA_READ_TIMEOUT' : failureCode};
    }
  };
  return {
    async operations() {
      const result = await read(`SELECT id,occurred_at,transaction_id,schema_name,table_name,entity_id,
        action,actor_key,request_id,changed_fields FROM public.system_operation_logs
        ORDER BY occurred_at DESC,id DESC LIMIT 100`, 'AUDIT_MIGRATION_REQUIRED', 'AUDIT_READ_FAILED');
      return {...result, events: result.rows};
    },
    async events() {
      const result = await read(`SELECT id,request_id,occurred_at,kind,method,route,status,duration_ms,code,persisted_at
        FROM public.operational_events ORDER BY occurred_at DESC,id DESC LIMIT 100`,
      'OPERATIONAL_EVENTS_MIGRATION_REQUIRED', 'OPERATIONAL_EVENTS_READ_FAILED');
      return {...result, events: result.rows};
    },
    async ragic() {
      // One bounded query includes only the latest run's metadata and at most 100 item codes.
      const result = await read(`SELECT r.id,r.request_id,r.status,r.error_code,r.total_count,r.succeeded_count,
        r.failed_count,r.identity_required_count,r.started_at,r.completed_at,
        (r.status='running') AS needs_attention,
        coalesce((SELECT jsonb_agg(item) FROM (SELECT source_kind,source_record_id,status,code,recorded_at
          FROM public.ragic_sync_items WHERE run_id=r.id ORDER BY id LIMIT 100) item),'[]'::jsonb) AS items
        FROM public.ragic_sync_runs r ORDER BY r.started_at DESC,r.id DESC LIMIT 1`,
      'RAGIC_LEDGER_MIGRATION_REQUIRED', 'RAGIC_LEDGER_READ_FAILED');
      return {...result, latestRun: result.rows[0] ?? null};
    },
  };
}
