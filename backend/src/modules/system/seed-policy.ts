/** Bootstrap policy shared by the seed and tests; never permits demo floor data in production. */
export function seedPolicy(environment: Record<string, string | undefined>) {
  const demo = environment.AYROVI_SEED_DEMO === 'true';
  if (demo && environment.NODE_ENV === 'production') throw new Error('Demo warehouse seeding is forbidden in production.');
  if (demo && !environment.SEED_WORKER_PASSWORD) throw new Error('Explicit demo seeding requires SEED_WORKER_PASSWORD from the test environment.');
  return { demo };
}
