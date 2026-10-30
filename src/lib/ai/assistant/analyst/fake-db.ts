// Test-only in-memory stand-in for the two Prisma models the task store touches.
// Rows mirror Prisma JSON-ish records; the fake checks only equality and `in`.
type Row = { [key: string]: any };
const matches = (row: Row, where: Row = {}) =>
  Object.entries(where).every(([key, value]) =>
    value && typeof value === 'object' && !(value instanceof Date) && 'in' in value
      ? value.in.includes(row[key])
      : value instanceof Date
        ? row[key]?.getTime() === value.getTime()
        : row[key] === value,
  );

export function createFakeDb() {
  const chats: Row[] = [];
  const tasks: Row[] = [];
  let tick = 0;
  const stamp = () => new Date(1_700_000_000_000 + ++tick);
  const analystTask = {
    findFirst: async ({ where }: any) =>
      structuredClone(
        tasks.filter(t => matches(t, where)).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null,
      ),
    findMany: async ({ where }: any) => structuredClone(tasks.filter(t => matches(t, where))),
    create: async ({ data }: any) => {
      const row = structuredClone({ ...data, createdAt: stamp(), updatedAt: stamp() });
      tasks.push(row);
      return structuredClone(row);
    },
    updateMany: async ({ where, data }: any) => {
      const hit = tasks.filter(t => matches(t, where));
      for (const t of hit) Object.assign(t, structuredClone(data), { updatedAt: stamp() });
      return { count: hit.length };
    },
  };
  const aiChat = {
    findFirst: async ({ where }: any) => chats.find(c => matches(c, where)) ?? null,
  };
  return {
    chats,
    tasks,
    prisma: {
      client: { analystTask, aiChat },
      transaction: async (fn: any) => fn({ analystTask, aiChat }),
    },
  };
}
