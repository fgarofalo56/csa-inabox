import { makeItemRoute } from '../../_lib/palantir-crud';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const { GET, PATCH, DELETE } = makeItemRoute('workshop-app');
