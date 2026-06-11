import { makeCollectionRoute } from '../_lib/palantir-crud';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const { GET, POST } = makeCollectionRoute('workshop-app');
