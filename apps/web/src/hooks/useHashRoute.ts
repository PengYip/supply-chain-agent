import { useCallback, useEffect, useState } from 'react';
import { isRoutableView, type ViewId } from '../components/shell/navigation';

/** 路由状态：一级视图 + 查询参数（如 `#/chat?session=<id>`）。 */
export interface RouteState {
  view: ViewId;
  params: Record<string, string>;
}

/** 解析 `#/view?key=value` 形式的 hash。纯函数。
 *  未注册 / 未开放的视图与空 hash 一律回退 chat（服务器无 SPA fallback，
 *  hash 路由是唯一可行方案，非法路径无需报错只需兜底）。
 *  前导斜杠必须剥掉：formatHash 产出 `#/view`，不剥则 path 带斜杠永远
 *  匹配不到注册表，所有导航都会静默回退 chat 并丢失查询参数。 */
export function parseHash(hash: string): RouteState {
  const raw = hash.replace(/^#/, '').replace(/^\/+/, '');
  const [path, query = ''] = raw.split('?');
  const params: Record<string, string> = {};
  new URLSearchParams(query).forEach((value, key) => {
    if (value !== '') params[key] = value;
  });
  const view: ViewId = isRoutableView(path) ? path : 'chat';
  return { view, params };
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
    const sync = () => setRoute(parseHash(window.location.hash));
    // hash 导航触发 hashchange；浏览器返回/前进两者都会触发，监听双事件兜底
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
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
