import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * A `chain.db` holding only the calibration table, for tests that score a board.
 *
 * `chain.db` is git-ignored, and `domain/calibration.ts` reads it when it is
 * there and reads nothing when it is not -- so a test that scores a board
 * passed on the desk's host and failed on a clean checkout (13 of them in
 * best-trade-watch, 30 Sep 2026). Import this first: it points `CHAIN_DB` at a
 * temp copy of the real table before `paths.ts` reads the variable.
 *
 * The rows are chain.db's `calibration` as of 30 Sep 2026 (735 settled days).
 */
const ROWS: [string, number, number, number, number, number, number][] = [
  ['em_distance', -1.5, -1.0, 107, 12, 0.11214953271028037, 467.93972583626174],
  ['em_distance', -1.0, -0.5, 498, 133, 0.26706827309236947, 518.3409242611446],
  ['em_distance', -0.5, 0.0, 1864, 683, 0.36641630901287553, 572.8271114226179],
  ['em_distance', 0.0, 0.5, 2383, 1192, 0.5002098195551825, 481.26823398794846],
  ['em_distance', 0.5, 1.0, 2328, 1497, 0.6430412371134021, 315.72430269914616],
  ['em_distance', 1.0, 1.5, 2333, 1751, 0.7505357908272611, 204.78273219378903],
  ['em_distance', 1.5, 2.0, 2336, 1962, 0.8398972602739726, 128.433504817055],
  ['em_distance', 2.0, 2.5, 2224, 1968, 0.8848920863309353, 83.06503144335433],
  ['em_distance', 2.5, 3.0, 2068, 1925, 0.9308510638297872, 54.73389706548361],
  ['em_distance', 3.0, 3.5, 1790, 1728, 0.9653631284916201, 38.001774619653695],
  ['em_distance', 3.5, 4.0, 1557, 1521, 0.976878612716763, 26.82263340644185],
  ['em_distance', 4.0, 4.5, 1351, 1337, 0.9896373056994818, 18.219312084781667],
  ['em_distance', 4.5, 5.0, 1122, 1114, 0.9928698752228164, 11.971945978859162],
  ['em_distance', 5.0, 5.5, 5368, 5362, 0.9988822652757079, 3.286598818504082],
  ['model_potm', 0.15, 0.2, 59, 8, 0.13559322033898305, 455.29500173457626],
  ['model_potm', 0.2, 0.25, 143, 29, 0.20279720279720279, 479.0682929665037],
  ['model_potm', 0.25, 0.3, 241, 60, 0.24896265560165975, 512.4352741996678],
  ['model_potm', 0.3, 0.35, 497, 156, 0.31388329979879276, 547.1788927182295],
  ['model_potm', 0.35, 0.39999999999999997, 807, 284, 0.35192069392812886, 584.6960751128744],
  ['model_potm', 0.4, 0.45, 930, 387, 0.4161290322580645, 588.6800554263442],
  ['model_potm', 0.45, 0.5, 937, 456, 0.48665955176093917, 519.0588406626146],
  ['model_potm', 0.5, 0.55, 937, 483, 0.5154749199573105, 441.6697438964252],
  ['model_potm', 0.55, 0.6000000000000001, 938, 556, 0.5927505330490405, 380.81950215570396],
  ['model_potm', 0.6, 0.65, 1042, 650, 0.6238003838771593, 308.9806069712956],
  ['model_potm', 0.65, 0.7000000000000001, 1072, 751, 0.7005597014925373, 261.54585935297547],
  ['model_potm', 0.7, 0.75, 1244, 932, 0.7491961414790996, 207.247102900619],
  ['model_potm', 0.75, 0.8, 1419, 1145, 0.806906272022551, 160.1800392107329],
  ['model_potm', 0.8, 0.8500000000000001, 1788, 1519, 0.8495525727069351, 117.89956619872481],
  ['model_potm', 0.85, 0.9, 2428, 2155, 0.8875617792421746, 78.95652467164743],
  ['model_potm', 0.9, 0.9500000000000001, 3843, 3650, 0.9497788186312777, 42.78421844602389],
  ['model_potm', 0.95, 1.0, 9012, 8973, 0.9956724367509987, 8.936730648513107],
];

const dir = mkdtempSync(join(tmpdir(), 'chain-fixture-'));
const path = join(dir, 'chain.db');
const db = new DatabaseSync(path);
db.exec(`CREATE TABLE calibration (
  kind TEXT NOT NULL, bucket_lo REAL NOT NULL, bucket_hi REAL NOT NULL,
  legs INTEGER NOT NULL, expired_0 INTEGER NOT NULL, rate REAL NOT NULL, avg_mark REAL NOT NULL,
  PRIMARY KEY (kind, bucket_lo))`);
const insert = db.prepare('INSERT INTO calibration VALUES (?, ?, ?, ?, ?, ?, ?)');
for (const r of ROWS) insert.run(...r);
db.close();

process.env.CHAIN_DB = path;
