import { useCallback, useEffect, useState } from 'react';
import { isRoutableView, type ViewId } from '../components/shell/navigation';

/** 路由状态：一级视图 + 查询参数（如 `#/chat?session=<id>`）。 */
export interface RouteState {
  view: ViewId;
  params: Record<string, string>;
}

/** 旧路由重定向表（导航整合 2026-09-08 / 菜单重构 2026-09-23 二期）：
 *  旧 hash 一级路径 -> 新视图 + 注入参数。查询参数优先级高于注入参数
 *  （如 `#/entities?type=X` 的 type 原样透传到新路由），兼容旧链接、书签与
 *  全景图等外部深链入口，保证旧 hash 不断链。
 *  audit -> governance usage tab：用量审计并入治理后台（2026-09-23 二期）。 */
const LEGACY_ROUTE_REDIRECTS: Record<string, { view: ViewId; inject: Record<string, string> }> = {
  entities: { view: 'ontology', inject: { tab: 'ledger' } },
  graph: { view: 'ontology', inject: { tab: 'graph' } },
  ledger: { view: 'projects', inject: { tab: 'ledger' } },
  // 己方主体并入本体台账：落地内部组织并自动打开己方名单管理抽屉
  parties: { view: 'ontology', inject: { tab: 'ledger', type: 'OrgUnit', parties: '1' } },
  // 用量审计并入治理后台：落地 usage tab
  audit: { view: 'governance', inject: { tab: 'usage' } },
};

/** 参数级平移（菜单重构 2026-09-23 二期）：勾稽自本体 tab 提级为顶层视图后，
 *  旧 `#/ontology?tab=gaps` 深链平移到 `#/gaps`（tab 参数丢弃，其余透传）。
 *  不能进 LEGACY_ROUTE_REDIRECTS —— 那是整路径级映射，会把所有 /ontology
 *  一并改写。 */
function applyParamRedirects(view: ViewId, params: Record<string, string>): RouteState {
  if (view === 'ontology' && params['tab'] === 'gaps') {
    const rest = { ...params };
    delete rest['tab'];
    return { view: 'gaps', params: rest };
  }
  return { view, params };
}

/** 解析 `#/view?key=value` 形式的 hash。纯函数。
 *  未注册 / 未开放的视图与空 hash 一律兜底 overview（登录后门户，roadmap Item 7；
 *  显式直链如 `#/chat?session=x` 走注册表正常解析，不受默认切换影响）。
 *  前导斜杠必须剥掉：formatHash 产出 `#/view`，不剥则 path 带斜杠永远
 *  匹配不到注册表，所有导航都会静默丢视图并丢失查询参数。
 *  旧路由（重定向表内）先映射为新视图再走注册表解析；
 *  参数级平移（如 ontology?tab=gaps -> gaps）最后套用。 */
export function parseHash(hash: string): RouteState {
  const raw = hash.replace(/^#/, '').replace(/^\/+/, '');
  const [path, query = ''] = raw.split('?');
  const params: Record<string, string> = {};
  new URLSearchParams(query).forEach((value, key) => {
    if (value !== '') params[key] = value;
  });
  const redirect = LEGACY_ROUTE_REDIRECTS[path];
  if (redirect) {
    return applyParamRedirects(redirect.view, { ...redirect.inject, ...params });
  }
  const view: ViewId = isRoutableView(path) ? path : 'overview';
  return applyParamRedirects(view, params);
}

/** 规范 hash：parseHash 的结果重新格式化后与原 hash 不一致则返回规范值，
 *  useHashRoute 用它做 URL 静默重写，使地址栏收敛到新路由（渲染不依赖重写：
 *  parseHash 已兼容旧 hash）。覆盖路径级重定向、参数级平移与编码差异。 */
export function canonicalHash(hash: string): string | null {
  const { view, params } = parseHash(hash);
  const canonical = formatHash(view, params);
  const raw = hash.replace(/^#/, '').replace(/^\/+/, '');
  return `/${raw}` === canonical.slice(1) ? null : canonical;
}

/** 生成 `#/view?key=value`。纯函数，与 parseHash 互逆。 */
export function formatHash(view: ViewId, params?: Record<string, string>): string {
  const entries = Object.entries(params ?? {}).filter(([, v]) => v !== '');
  const query = entries.length > 0 ? `?${new URLSearchParams(entries).toString()}` : '';
  return `#/${view}${query}`;
}

/** 轻量 hash 路由（生产环境 Hono serveStatic 无 SPA fallback，故不用 history 模式）。
 *  返回当前路由与 navigate；navigate 默认产生一条浏览器历史（跨视图跳转），
 *  opts.replace 用于视图内高频切换（如会话切换），避免灌爆历史记录。 */
export function useHashRoute() {
  const [route, setRoute] = useState<RouteState>(() => parseHash(window.location.hash));

  useEffect(() => {
    const sync = () => {
      // 旧路由静默重写为规范 hash（replaceState 不触发 hashchange，state 随后照常解析）
      const canonical = canonicalHash(window.location.hash);
      if (canonical !== null && window.location.hash !== canonical) {
        window.history.replaceState(null, '', canonical);
      }
      setRoute(parseHash(window.location.hash));
    };
    // hash 导航触发 hashchange；浏览器返回/前进两者都会触发，监听双事件兜底
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    sync();
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);

  const navigate = useCallback(
    (view: ViewId, params?: Record<string, string>, opts?: { replace?: boolean }) => {
      const hash = formatHash(view, params);
      if (window.location.hash === hash) {
        setRoute(parseHash(hash));
        return;
      }
      if (opts?.replace) {
        // replaceState 不触发 hashchange，需手动同步 state
        window.history.replaceState(null, '', hash);
        setRoute(parseHash(hash));
      } else {
        window.location.hash = hash;
      }
    },
    [],
  );

  return { route, navigate };
}
