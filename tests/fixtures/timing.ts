import {readFileSync} from 'node:fs';
import {z} from 'zod';

const Profile=z.enum(['native','qemu-amd64']);
const Budget=z.object({deadlineMultiplier:z.number().int().positive(),concurrency:z.number().int().positive()}).strict();
const profiles=z.object({native:Budget,'qemu-amd64':Budget}).strict().parse(JSON.parse(readFileSync(new URL('./timing.json',import.meta.url),'utf8')));
/** Explicit test-host allowance for CPU-emulated process startup. This changes
 * only opted-in verification deadlines, never production configuration, injected
 * clocks, expected outcomes or the ordering of timeout/failure assertions. */
export const timingProfile=Profile.parse(process.env.POLARITON_TEST_PROFILE??'native');
export const testConcurrency=profiles[timingProfile].concurrency;
export function testDeadline(milliseconds:number):number{
 return z.number().int().positive().safe().parse(milliseconds*profiles[timingProfile].deadlineMultiplier);
}
