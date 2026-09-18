import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import ws from "ws";
import * as schema from "@shared/schema";

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
}

// 連線池快取
const schemaPools = new Map<string, ReturnType<typeof drizzle>>();

/**
 * Task #33 — schema 名安全化。
 *
 * `assertSchoolCode` is the SINGLE entry point that gates every code path
 * which interpolates a school code into SQL. It enforces both the regex
 * (no SQL-unsafe characters) and the runtime whitelist of registered
 * schools. Any new helper or repository function that needs a school
 * code MUST call this function before constructing identifiers.
 *
 * `schoolSchemaName` returns the validated schema string so callers can
 * pass it to `sql.identifier()` (drizzle quotes the identifier with
 * double quotes). No call site should ever interpolate `school_${code}`
 * directly into a `sql.raw` template — use `sql.identifier(...)` instead.
 */
export function assertSchoolCode(schoolCode: string): void {
  if (!isValidSchoolCode(schoolCode)) {
    throw new Error(`Invalid school code: ${schoolCode}`);
  }
  if (!getAvailableSchools().includes(schoolCode)) {
    throw new Error(`Unknown school code: ${schoolCode}`);
  }
}

export function schoolSchemaName(schoolCode: string): string {
  assertSchoolCode(schoolCode);
  return `school_${schoolCode}`;
}

/**
 * 根據學校代碼獲取對應的資料庫連線
 * 使用不同的 schema 來隔離各學校資料
 */
export async function getSchoolDb(schoolCode: string) {
  assertSchoolCode(schoolCode);
  const schemaName = schoolSchemaName(schoolCode);
  const cacheKey = schoolCode;

  if (schemaPools.has(cacheKey)) {
    return schemaPools.get(cacheKey)!;
  }

  // 檢查資料庫連接是否可用
  if (!process.env.DATABASE_URL) {
    throw new Error(`❌ DATABASE_URL not configured. Please set up database for school: ${schoolCode}`);
  }

  // 創建新的連線池
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });

  const db = drizzle({ client: pool, schema });

  // 設定 search_path 到指定的 schema
  try {
    // 先檢查 schema 是否存在，如果不存在則自動創建
    await ensureSchemaExists(db, schoolCode);

    // sql.identifier() quotes the schema name; combined with the strict
    // whitelist in assertSchoolCode this removes the schema-name SQL
    // injection risk that previously lived in sql.raw template literals.
    await db.execute(sql`SET search_path TO ${sql.identifier(schemaName)}, public;`);
    console.log(`✅ Set search_path to ${schemaName}`);

    // 在部署環境中額外確保連接
    const isDeployment = process.env.REPLIT_DEPLOYMENT === '1';
    if (isDeployment) {
      console.log(`🚀 Running in deployment mode for ${schemaName}`);
    } else {
      console.log(`🛠️ Running in development mode for ${schemaName}`);
    }
  } catch (error) {
    console.error(`❌ Failed to set search_path for ${schemaName}:`, error);

    // 提供更詳細的錯誤信息
    const isDeployment = process.env.REPLIT_DEPLOYMENT === '1';
    if (isDeployment) {
      console.error('🚨 部署環境資料庫錯誤 - 請檢查 DATABASE_URL 環境變數是否正確設置');
      console.error('💡 提示：部署環境需要獨立的資料庫配置');
    }

    throw new Error(`Database connection failed for school ${schoolCode}. Please check database configuration.`);
  }

  schemaPools.set(cacheKey, db);

  return db;
}

/**
 * 確保學校 schema 存在，如果不存在則自動創建
 */
async function ensureSchemaExists(db: any, schoolCode: string) {
  const schemaName = schoolSchemaName(schoolCode);
  try {
    // information_schema query: schema_name is a regular value column,
    // so it's bound as a parameter — no identifier interpolation needed.
    const result = await db.execute(sql`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name = ${schemaName}
    `);

    if (result.rows.length === 0) {
      console.log(`🔧 Schema ${schemaName} 不存在，自動創建中...`);
      await initializeSchoolSchema(schoolCode);
    } else {
      console.log(`✅ Schema ${schemaName} 已存在`);
    }
  } catch (error) {
    console.log(`⚠️ Schema 檢查失敗，嘗試創建: ${error}`);
    // 如果檢查失敗，嘗試創建 schema
    try {
      await initializeSchoolSchema(schoolCode);
    } catch (initError) {
      console.error(`❌ 無法創建 schema ${schemaName}:`, initError);
      throw initError;
    }
  }
}

/**
 * 初始化學校資料庫 schema
 * 創建 schema 並複製必要的表結構
 */
export async function initializeSchoolSchema(schoolCode: string) {
  assertSchoolCode(schoolCode);
  const schemaName = schoolSchemaName(schoolCode);
  const mainPool = new Pool({ connectionString: process.env.DATABASE_URL });
  const mainDb = drizzle({ client: mainPool, schema });

  // sql.identifier() applies PostgreSQL identifier quoting; the value
  // itself is already validated by assertSchoolCode above. Together
  // these eliminate the schema-level injection vector that string
  // interpolation into sql.raw would expose.
  const schemaIdent = sql.identifier(schemaName);

  try {
    // ✅ 關鍵修復：啟用 pgcrypto 擴展以支援 gen_random_uuid()
    await mainDb.execute(sql`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
    console.log('✅ pgcrypto extension enabled');

    // 創建 schema
    await mainDb.execute(sql`CREATE SCHEMA IF NOT EXISTS ${schemaIdent};`);

    // 設置 search_path 到新 schema
    await mainDb.execute(sql`SET search_path TO ${schemaIdent};`);

    // 創建 venues 表並從 public schema 複製資料
    await mainDb.execute(sql`
      CREATE TABLE IF NOT EXISTS ${schemaIdent}.venues AS
      SELECT * FROM public.venues;
    `);

    // 創建 time_slots 表並從 public schema 複製資料
    await mainDb.execute(sql`
      CREATE TABLE IF NOT EXISTS ${schemaIdent}.time_slots AS
      SELECT * FROM public.time_slots;
    `);

    // 創建 schedules 表結構（空表，每校獨立資料）
    await mainDb.execute(sql`
      CREATE TABLE IF NOT EXISTS ${schemaIdent}.schedules (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        date DATE NOT NULL,
        venue_id VARCHAR NOT NULL,
        time_slot_id VARCHAR NOT NULL,
        class_name VARCHAR,
        coach_name VARCHAR,
        coach_name_2 VARCHAR,
        coach_user_id VARCHAR,
        coach_user_id_2 VARCHAR,
        version INTEGER NOT NULL DEFAULT 1,
        coach1_is_teaching BOOLEAN NOT NULL DEFAULT false,
        coach2_is_teaching BOOLEAN NOT NULL DEFAULT false,
        is_class_locked BOOLEAN NOT NULL DEFAULT false,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 補上既有表格可能缺少的欄位（向下相容）
    await mainDb.execute(sql`
      ALTER TABLE ${schemaIdent}.schedules
        ADD COLUMN IF NOT EXISTS coach_user_id VARCHAR,
        ADD COLUMN IF NOT EXISTS coach_user_id_2 VARCHAR,
        ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
    `);
    await mainDb.execute(sql`
      ALTER TABLE ${schemaIdent}.schedules ADD COLUMN IF NOT EXISTS coach_name_2 VARCHAR;
    `);
    await mainDb.execute(sql`
      ALTER TABLE ${schemaIdent}.schedules ADD COLUMN IF NOT EXISTS coach1_is_teaching BOOLEAN NOT NULL DEFAULT false;
    `);
    await mainDb.execute(sql`
      ALTER TABLE ${schemaIdent}.schedules ADD COLUMN IF NOT EXISTS coach2_is_teaching BOOLEAN NOT NULL DEFAULT false;
    `);
    await mainDb.execute(sql`
      ALTER TABLE ${schemaIdent}.schedules ADD COLUMN IF NOT EXISTS coach_count INTEGER NOT NULL DEFAULT 1;
    `);
    await mainDb.execute(sql`
      ALTER TABLE ${schemaIdent}.schedules ADD COLUMN IF NOT EXISTS is_class_locked BOOLEAN NOT NULL DEFAULT false;
    `);

    // 創建 teachers 表
    await mainDb.execute(sql`
      CREATE TABLE IF NOT EXISTS ${schemaIdent}.teachers (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        teacher_name VARCHAR NOT NULL,
        subject VARCHAR,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 創建 teacher_feedbacks 表
    await mainDb.execute(sql`
      CREATE TABLE IF NOT EXISTS ${schemaIdent}.teacher_feedbacks (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        schedule_id VARCHAR NOT NULL,
        teacher_id VARCHAR,
        teacher_name VARCHAR NOT NULL,
        status VARCHAR NOT NULL,
        reschedule_date DATE,
        reschedule_period VARCHAR,
        comment TEXT,
        updated_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (schedule_id) REFERENCES ${schemaIdent}.schedules(id) ON DELETE CASCADE,
        UNIQUE (schedule_id, teacher_name)
      );
    `);
    await mainDb.execute(sql`
      ALTER TABLE ${schemaIdent}.teacher_feedbacks
      ADD COLUMN IF NOT EXISTS teacher_id VARCHAR;
    `);
    await mainDb.execute(sql`
      UPDATE ${schemaIdent}.teacher_feedbacks feedback
      SET teacher_id = teacher.id
      FROM ${schemaIdent}.teachers teacher
      WHERE feedback.teacher_id IS NULL
        AND feedback.teacher_name = teacher.teacher_name;
    `);
    await mainDb.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS teacher_feedbacks_schedule_teacher_id_unique
      ON ${schemaIdent}.teacher_feedbacks (schedule_id, teacher_id)
      WHERE teacher_id IS NOT NULL;
    `);

    // 為示範學校添加課表資料（只在demo時執行）
    if (schoolCode === 'demo') {
      await seedDemoData(mainDb, schemaIdent);
    }

    console.log(`✅ Successfully initialized schema for school: ${schoolCode}`);

  } catch (error) {
    console.error(`❌ Failed to initialize schema for school ${schoolCode}:`, error);
    throw error;
  } finally {
    await mainPool.end();
  }
}

/**
 * 為示範學校添加課表和教師資料
 *
 * `schemaIdent` is a pre-built `sql.identifier(...)` chunk from the
 * caller — never a raw string — so this function inherits the
 * identifier-quoting safety. Row values are bound through `sql` template
 * parameters (no inline interpolation of teacher names).
 */
async function seedDemoData(db: any, schemaIdent: ReturnType<typeof sql.identifier>) {
  try {
    // 檢查是否已有教師資料
    const existingTeachers = await db.execute(sql`SELECT COUNT(*) as count FROM ${schemaIdent}.teachers`);
    const teacherCount = existingTeachers.rows[0]?.count || 0;

    if (teacherCount === 0) {
      // 添加教師資料
      const teachers: Array<[string, string]> = [
        ['吳育汝', '游泳'],
        ['周彥真', '游泳'],
        ['張宇熙', '游泳'],
        ['張暐承', '游泳'],
        ['李冠賢', '游泳'],
        ['王慶熙', '游泳'],
        ['蔡正雄', '游泳'],
        ['邱俊傑', '游泳'],
        ['陳潔', '游泳'],
        ['王老師', '數學'],
        ['李老師', '英語'],
        ['張老師', '物理'],
        ['陳老師', '化學']
      ];

      for (const [teacherName, subject] of teachers) {
        await db.execute(sql`
          INSERT INTO ${schemaIdent}.teachers (teacher_name, subject)
          VALUES (${teacherName}, ${subject});
        `);
      }
    }

    // 添加課表資料（2024年9月16-20日）
    const scheduleData: Array<[string, string, string, string]> = [
      ['2024-09-16', '113', '張暐承', '新北高中第二學期體育課程'],
      ['2024-09-17', '115', '周彥真', '新北高中第二學期體育課程'],
      ['2024-09-18', '114', '李冠賢', '新北高中第二學期體育課程'],
      ['2024-09-19', '112', '王慶熙', '新北高中第二學期體育課程'],
      ['2024-09-20', '116', '吳育汝', '新北高中第二學期體育課程'],
      ['2024-09-16', '201', '張宇熙', '新北高中第二學期體育課程'],
      ['2024-09-17', '202', '蔡正雄', '新北高中第二學期體育課程'],
      ['2024-09-18', '203', '邱俊傑', '新北高中第二學期體育課程'],
      ['2024-09-19', '204', '陳潔', '新北高中第二學期體育課程'],
      ['2024-09-20', '205', '張暐承', '新北高中第二學期體育課程']
    ];

    // 檢查是否已有資料，避免重複插入
    const existingSchedules = await db.execute(sql`SELECT COUNT(*) as count FROM ${schemaIdent}.schedules`);
    const count = existingSchedules.rows[0]?.count || 0;

    if (count === 0) {
      for (const [date, className, coachName, notes] of scheduleData) {
        await db.execute(sql`
          INSERT INTO ${schemaIdent}.schedules (date, venue_id, time_slot_id, class_name, coach_name, notes)
          VALUES (${date},
                  (SELECT id FROM ${schemaIdent}.venues LIMIT 1),
                  (SELECT id FROM ${schemaIdent}.time_slots LIMIT 1),
                  ${className}, ${coachName}, ${notes});
        `);
      }
    }

    console.log(`✅ Demo data seeded`);
  } catch (error) {
    console.error(`⚠️ Error seeding demo data:`, error);
    // 不拋出錯誤，因為資料可能已存在
  }
}

/**
 * 獲取所有可用的學校列表
 */
export function getAvailableSchools(): string[] {
  // 這裡可以從配置文件或環境變數中讀取
  // 暫時回傳示例學校列表
  return ['demo', 'school1', 'school2'];
}

const SCHOOL_NAMES: Record<string, string> = {
  demo: "新北高中",
  school1: "學校一",
  school2: "學校二",
};

export function getSchoolPublicInfo(schoolCode: string): { code: string; name: string } {
  assertSchoolCode(schoolCode);
  return { code: schoolCode, name: SCHOOL_NAMES[schoolCode] ?? schoolCode };
}

/**
 * 驗證學校代碼是否有效
 */
export function isValidSchoolCode(schoolCode: string): boolean {
  return /^[a-zA-Z0-9_]+$/.test(schoolCode) && schoolCode.length >= 2 && schoolCode.length <= 20;
}
