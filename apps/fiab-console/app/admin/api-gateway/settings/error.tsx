'use client';

import { RouteError, type RouteErrorProps } from '@/lib/components/route-error';

export default function ApiGatewaySettingsError(props: RouteErrorProps) {
  return <RouteError {...props} section="API Gateway settings" />;
}
