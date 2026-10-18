import {Pool} from '@neondatabase/serverless';
import {boundedMetadataQuery,createMetadataSnapshotReader,requireReadonlyMetadataClient} from '../shared/metadataRead';

// A separate small read-only pool keeps stalled monitoring queries from filling
// the business-write pool. Server timeout cancels SQL; the client deadline also
// destroys its connection if acquisition/network transport stalls.
const metadataPool = new Pool({connectionString: process.env.DATABASE_URL, max: 3,
  connectionTimeoutMillis: 1500, idleTimeoutMillis: 10000, query_timeout: 2000,
  options: '-c default_transaction_read_only=on -c statement_timeout=1500'});
export const metadataSnapshots = createMetadataSnapshotReader((text,values) =>
  boundedMetadataQuery(() => metadataPool.connect(),text,values,2500,requireReadonlyMetadataClient));
