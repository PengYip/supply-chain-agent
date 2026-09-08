import { useCallback, useEffect, useState } from 'react';
import { isRoutableView, type ViewId } from '../components/shell/navigation';

/** 路由状态：一级视图 + 查询参数（如 `#/chat?session=<id>`）。 */
export interface RouteState {
  view: ViewId;
  params: Record<string, string>;
}

/** 旧路由重定向表（导航整合 2026-09-08）：旧 hash 一级路径 -> 新视图 + 注入参数。
 *  查询参数优先级高于注入参数（如 `#/entities?type=X` 的 type 原样透传到新路由），
 *  兼容旧链接、书签与全景图等外部深链入口，保证旧 hash 不断链。 */
const LEGACY_ROUTE_REDIRECTS: Record<string, { view: ViewId; inject: Record<string, string> }> = {
  entities: { view: 'ontology', inject: { tab: 'ledger' } },
  graph: { view: 'ontology', inject: { tab: 'graph' } },
};

/** 解析 `#/view?key=value` 形式的 hash。纯函数。
 *  未注册 / 未开放的视图与空 hash 一律兜底 overview（登录后门户，roadmap Item 7；
 *  显式直链如 `#/chat?session=x` 走注册表正常解析，不受默认切换影响）。
 *  前导斜杠必须剥掉：formatHash 产出 `#/view`，不剥则 path 带斜杠永远
 *  匹配不到注册表，所有导航都会静默丢视图并丢失查询参数。
 *  旧路由（重定向表内）先映射为新视图再走注册表解析。 */
export function parseHash(hash: string): RouteState {
  const raw = hash.replace(/^#/, '').replace(/^\/+/, '');
  const [path, query = ''] = raw.split('?');
  const params: Record<string, string> = {};
  new URLSearchParams(query).forEach((value, key) => {
    if (value !== '') params[key] = value;
  });
  const redirect = LEGACY_ROUTE_REDIRECTS[path];
  if (redirect) {
    return { view: redirect.view, params: { ...redirect.inject, ...params } };
  }
  const view: ViewId = isRoutableView(path) ? path : 'overview';
  return { view, params };
}

/** 旧路由对应的规范 hash；非旧路由返回 null。useHashRoute 用它做 URL 静默重写，
 *  使地址栏收敛到新路由（渲染不依赖重写：parseHash 已兼容旧 hash）。 */
export function canonicalHash(hash: string): string | null {
  const raw = hash.replace(/^#/, '').replace(/^\/+/, '');
  const [path] = raw.split('?');
  if (!LEGACY_ROUTE_REDIRECTS[path]) return null;
  const { view, params } = parseHash(hash);
  return formatHash(view, params);
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
