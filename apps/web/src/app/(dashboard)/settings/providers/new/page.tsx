import { ProviderEditor } from '../_components/provider-editor';
import { ProviderTemplatePicker } from '../_components/provider-template-picker';

export default async function NewProviderPage({
  searchParams,
}: {
  searchParams: Promise<{ template?: string }>;
}) {
  const { template } = await searchParams;
  if (!template) return <ProviderTemplatePicker />;
  return <ProviderEditor templateId={template} />;
}
