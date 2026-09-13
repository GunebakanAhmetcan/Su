import { deliverJob, restClient, json } from '../../src/server/push.mjs';
export const config = { schedule: '*/10 * * * *' };
export default async function handler() {
  const rest = restClient();
  const results = await Promise.allSettled([deliverJob(rest), deliverJob(rest)]);
  const attempted = results.filter(result => result.status === 'fulfilled' && !result.value.skipped).length;
  return json({ attempted });
}
