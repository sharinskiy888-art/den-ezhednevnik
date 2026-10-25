"""Запуск сервера «День» одной командой — так же его запускают служба Linux и программа для Windows.

  python -m server.run              сервер (адрес и порт — DEN_HOST, DEN_PORT в den.env)
  python -m server.run admin ...    команды администратора (то же, что python -m server.admin)
  python -m server.run version      номер версии
  python -m server.run init-env <папка данных>   создать den.env рядом с программой (секрет — случайный), если его нет
"""
import os
import sys


def init_env(args):
    """Для установщика Windows: den.env с длинным случайным секретом рядом с den-server.exe. Существующий не трогается."""
    import secrets
    from pathlib import Path
    if len(args) != 1:
        sys.exit('Укажите папку данных')
    target = Path(sys.argv[0]).resolve().parent / 'den.env'
    if target.exists():
        print(f'{target} уже есть — не меняю')
        return
    target.write_text('# Секреты и настройки сервера «День». Не копировать в архивы и чаты.\n'
                      f'DEN_SECRET={secrets.token_urlsafe(48)}\n'
                      f'DEN_DATA_DIR={args[0]}\n'
                      f'DEN_STATIC_DIR={target.parent}\n'
                      'DEN_HOST=0.0.0.0\n'  # в местной сети; наружу закрывает брандмауэр (правило «только локальная подсеть»)
                      'DEN_PORT=8787\n', encoding='utf-8')
    print(f'Создан {target}')


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ['init-env']:
        init_env(argv[1:])
        return
    if argv[:1] in (['version'], ['--version']):  # без den.env: им проверяют только что собранную программу
        import json
        from pathlib import Path
        print(json.loads((Path(__file__).resolve().parent.parent / 'version.json').read_text(encoding='utf-8'))['version'])
        return
    from . import db  # читает den.env и проверяет секрет: без него сервер не стартует
    if argv[:1] == ['admin']:
        from . import admin
        admin.main(argv[1:])
        return
    if argv:
        sys.exit(__doc__)
    import uvicorn
    from .main import app
    # Журнал запросов выключен: в адресах бывают id и поисковые слова, а телефоны и адреса клиентов в журнал не пишутся.
    uvicorn.run(app, host=os.environ.get('DEN_HOST') or '127.0.0.1', port=int(os.environ.get('DEN_PORT') or 8787),
                loop='asyncio', http='h11', access_log=False, log_level='warning',
                proxy_headers=False)  # адрес за nginx разбирает access.client_ip, только от DEN_TRUSTED_PROXY


if __name__ == '__main__':
    main()
