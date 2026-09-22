// patchContractType API 契约测试(business-loop Wave 7 修复轮)：错误码 -> 中文文案
// 映射 + 200 响应 ok 字段消费。stubGlobal fetch(照 api/tradeEvents.test.ts 模式)，
// 纯客户端行为不依赖后端。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { patchContractType } from './contracts';

function stubFetchOnce(status: number, body: unknown) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('patchContractType 服务端响应映射', () => {
  it('404 contract_not_found(含非本人台账行情形)映射为接地中文文案', async () => {
    stubFetchOnce(404, { ok: false, error: 'contract_not_found' });
    const err = await patchContractType('XYRL-2022-225', '采购').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('未找到可修正的合同台账行');
  });

  it('200 带 ok:false 的异常形状不误判成功: 带错误码按映射, 无码按响应异常', async () => {
    stubFetchOnce(200, { ok: false, error: 'contract_not_found' });
    const err = await patchContractType('C-1', '采购').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('未找到可修正的合同台账行');

    stubFetchOnce(200, { ok: false });
    const err2 = await patchContractType('C-1', '采购').catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(Error);
    expect((err2 as Error).message).toBe('响应异常，请稍后重试');
  });

  it('200 ok:true 正常解析: PATCH 方法 + 字段归一化(refreshedDocuments=张口径, refreshedFlows 别名同值)', async () => {
    const fetchMock = stubFetchOnce(200, {
      ok: true, contractNo: 'XYRL-2022-225', contractType: '采购',
      refreshedDocuments: 3, refreshedFlows: 3, failed: 0, skipped: [],
    });
    const res = await patchContractType('XYRL-2022-225', '采购');
    expect(res.ok).toBe(true);
    expect(res.refreshedDocuments).toBe(3);
    expect(res.refreshedFlows).toBe(3);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/contracts/XYRL-2022-225/type',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('W8 T4 同部署兜底: 服务端仅返 refreshedFlows(旧形状) -> refreshedDocuments 回退同值', async () => {
    stubFetchOnce(200, {
      ok: true, contractNo: 'XYRL-2022-225', contractType: '采购',
      refreshedFlows: 2, failed: 0, skipped: [],
    });
    const res = await patchContractType('XYRL-2022-225', '采购');
    expect(res.refreshedDocuments).toBe(2);
    expect(res.refreshedFlows).toBe(2);
  });
});
