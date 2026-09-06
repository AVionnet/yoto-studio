/** Applique le schema et affiche l'etat. `npm run migrate` */
import { db } from './index.ts';

const handle = db();
const tables = handle
  .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            ORDER BY name`)
  .all() as { name: string }[];

for (const { name } of tables) {
  const { n } = handle.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number };
  console.log(`  ${name.padEnd(12)} ${n} ligne(s)`);
}
console.log(`\nBase prete : ${tables.length} tables.`);
