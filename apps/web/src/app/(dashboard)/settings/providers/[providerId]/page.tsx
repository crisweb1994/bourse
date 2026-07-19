import { ProviderEditor } from '../_components/provider-editor';

export default async function ProviderDetailPage({
  params,
}: {
  params: Promise<{ providerId: string }>;
}) {
  const { providerId } = await params;
  return <ProviderEditor providerId={providerId} />;
}
