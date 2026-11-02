// Человекочитаемые ошибки сети/прокси (общие для service worker и интерфейса)
export const NET_RU = {
  'net::ERR_PROXY_CONNECTION_FAILED': 'Не удалось подключиться к прокси',
  'net::ERR_TUNNEL_CONNECTION_FAILED': 'Прокси отказал в туннеле',
  'net::ERR_SOCKS_CONNECTION_FAILED': 'Ошибка SOCKS-рукопожатия',
  'net::ERR_SOCKS_CONNECTION_HOST_UNREACHABLE': 'SOCKS: узел недоступен',
  'net::ERR_EMPTY_RESPONSE': 'Пустой ответ (неверный протокол?)',
  'net::ERR_INVALID_HTTP_RESPONSE': 'Некорректный ответ (неверный протокол?)',
  'net::ERR_CONNECTION_CLOSED': 'Соединение закрыто прокси',
  'net::ERR_CONNECTION_RESET': 'Соединение сброшено',
  'net::ERR_TIMED_OUT': 'Таймаут',
  'net::ERR_CONNECTION_TIMED_OUT': 'Таймаут соединения',
  'net::ERR_PROXY_AUTH_UNSUPPORTED': 'Схема авторизации не поддерживается',
  'net::ERR_NAME_NOT_RESOLVED': 'Хост прокси не найден (DNS)',
  TIMEOUT: 'Таймаут', AUTH: 'Неверный логин/пароль прокси', NETWORK: 'Сетевая ошибка',
  SOCKS_AUTH: 'Chrome не умеет логин/пароль для SOCKS — возьмите HTTP-вариант этого прокси или авторизацию по IP',
};
export const describeError = (code) => NET_RU[code] || code || '';
