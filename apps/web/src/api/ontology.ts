export interface OntologyEntitySchemaDTO {
  name: string;
  label: string;
  ownFields: string[];
  fields: string[];
  meaning: string | null;
}

export interface OntologySchemaDTO {
  version: string;
  enums: Record<string, string[]>;
  entities: OntologyEntitySchemaDTO[];
  relations: Array<{
    name: string;
    description: string;
    pairs: Array<{ from: string; to: string }>;
    params: string[];
    meaning: string | null;
  }>;
}

async function request<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include' });
  } catch {
    throw new Error('网络错误，请稍后重试');
  }
  if (!res.ok) {
    let message = `请求失败（${res.status}）`;
    try {
      const data = (await res.json()) as { error?: string; detail?: string };
      if (data?.error) message = data.detail ? `${data.error}：${data.detail}` : data.error;
    } catch { /* 非 JSON 响应，保留状态码消息 */ }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export function fetchOntologySchema(): Promise<OntologySchemaDTO> {
  return request<OntologySchemaDTO>('/api/ontology/schema');
}
