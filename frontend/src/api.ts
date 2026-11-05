export class RequestError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}
export async function request<T>(path: string, options: { body?: unknown; csrf?: string; signal?: AbortSignal } = {}): Promise<T> {
  let response: Response;
  try { response = await fetch('/api/console' + path, {
    method: options.body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    signal: options.signal ?? AbortSignal.timeout(/^\/apps\/[^/]+\/delete$/.test(path) ? 60000 : 15000), headers: options.body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(options.body === undefined ? {} : { body: JSON.stringify({ ...options.body as object, csrfToken: options.csrf }) }),
  });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new RequestError((error as Error).name === 'TimeoutError' ? 'Сервер не ответил вовремя. Проверьте результат перед повторной отправкой.' : 'Нет соединения с сервером. Проверьте сеть и повторите.', 0, 'network_error');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new RequestError(data?.error?.message ?? 'Не удалось выполнить запрос. Повторите позже.', response.status, data?.error?.code ?? 'request_failed');
  if (!data) throw new RequestError('Сервер вернул неожиданный ответ. Обновите страницу.', 502, 'invalid_response');
  return data as T;
}
