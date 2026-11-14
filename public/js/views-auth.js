// Экран входа и регистрации.
import { api } from './api.js';
import { icon, logoMark } from './icons.js';
import { esc, toast } from './ui.js';

export function loginView(ctx) {
  const meta = ctx.meta || {};
  const html = `
  <div class="auth">
    <section class="auth-art">
      <div class="auth-brand">
        <span class="brand-mark">${logoMark(19)}</span>
        <div>
          <div class="brand-name">${esc(meta.name || 'OmniDash')}</div>
          <div class="brand-sub">control plane</div>
        </div>
      </div>
      <div>
        <h1 class="auth-title">Панель управления<br/><span>серверами</span></h1>
        <p class="auth-sub">Серверы, порты, лимиты, доступы и сроки аренды — в одном тёмном интерфейсе.
        Реальные процессы, живая консоль, файлы и бэкапы. Без GitHub и лишних зависимостей.</p>
        <div class="auth-feats">
          <div class="auth-feat">${icon('terminal', 15)} <span>Живая консоль и управление питанием</span></div>
          <div class="auth-feat">${icon('users', 15)} <span>Выдача серверов и доступов по правам</span></div>
          <div class="auth-feat">${icon('network', 15)} <span>Порты, лимиты CPU / RAM / диска и сроки</span></div>
          <div class="auth-feat">${icon('backup', 15)} <span>Бэкапы, расписание и автообновление панели</span></div>
        </div>
      </div>
      <div class="auth-foot">
        <span class="live-dot"></span> ${esc(meta.company || 'OmniDash Cloud')} · v${esc(meta.version || '1.0.0')} · ${new Date().getFullYear()}
      </div>
    </section>

    <section class="auth-panel">
      <div class="auth-box">
        <div class="panel-mini">
          <span class="pm-icon"><img src="/anime.jpg" alt="OmniDash" /></span>
          <div>
            <div class="pm-name">${esc(meta.name || 'OmniDash')}</div>
            <div class="pm-sub">control plane · v${esc(meta.version || '1.0.0')}</div>
          </div>
          <span class="pm-gear" title="Панель">${icon('settings', 16)}</span>
        </div>
        <div class="auth-mobile-brand">
          <span class="brand-mark">${logoMark(19)}</span>
          <div><div class="brand-name">${esc(meta.name || 'OmniDash')}</div><div class="brand-sub">control plane</div></div>
        </div>
        <h2 id="auth-title">Вход в панель</h2>
        <p class="sub" id="auth-sub">Введите логин и пароль, выданные администратором.</p>
        <div class="auth-error" id="auth-error"></div>
        <form class="auth-form" id="login-form" autocomplete="on">
          <div class="field">
            <label for="login-username">Логин</label>
            <input class="input" id="login-username" name="username" placeholder="admin" autocomplete="username" required />
          </div>
          <div class="field">
            <label for="login-password">Пароль</label>
            <input class="input" id="login-password" name="password" type="password" placeholder="••••••••" autocomplete="current-password" required />
          </div>
          <button class="btn primary" type="submit" id="login-btn">${icon('logout', 15)} Войти</button>
        </form>

        <form class="auth-form hidden" id="register-form">
          <div class="field">
            <label for="reg-username">Логин</label>
            <input class="input" id="reg-username" name="username" placeholder="nickname" autocomplete="username" required />
          </div>
          <div class="field">
            <label for="reg-email">E-mail</label>
            <input class="input" id="reg-email" name="email" type="email" placeholder="you@example.com" autocomplete="email" />
          </div>
          <div class="field">
            <label for="reg-password">Пароль</label>
            <input class="input" id="reg-password" name="password" type="password" placeholder="минимум 8 символов" autocomplete="new-password" required />
          </div>
          <button class="btn primary" type="submit">${icon('users', 15)} Создать аккаунт</button>
        </form>

        <form class="auth-form hidden" id="recover-form">
          <div class="field">
            <label for="rec-email">E-mail, привязанный к аккаунту</label>
            <input class="input" id="rec-email" name="email" type="email" placeholder="you@example.com" autocomplete="email" required />
          </div>
          <div class="field">
            <label for="rec-password">Новый пароль</label>
            <input class="input" id="rec-password" name="password" type="password" placeholder="минимум 8 символов" autocomplete="new-password" required />
          </div>
          <button class="btn primary" type="submit">${icon('key', 15)} Сбросить пароль</button>
          <div class="hint">Восстановление — по привязанному e-mail: введите его и новый пароль.</div>
        </form>

        <div class="auth-alt">
          ${meta.registrationOpen ? `Нет аккаунта? <a href="#" id="switch-mode">Зарегистрироваться</a> · ` : `Регистрация закрыта — аккаунт выдаёт администратор. · `}
          <a href="#" id="switch-recover">Забыли пароль?</a>
        </div>


      </div>
    </section>
  </div>`;

  function mount(root) {
    const loginForm = root.querySelector('#login-form');
    const registerForm = root.querySelector('#register-form');
    const recoverForm = root.querySelector('#recover-form');
    const title = root.querySelector('#auth-title');
    const sub = root.querySelector('#auth-sub');
    const error = root.querySelector('#auth-error');
    let mode = 'login';

    const showError = (message) => {
      error.textContent = message;
      error.classList.add('show');
      setTimeout(() => error.classList.remove('show'), 5000);
    };

    const setMode = (next) => {
      mode = next;
      loginForm.classList.toggle('hidden', next !== 'login');
      registerForm.classList.toggle('hidden', next !== 'register');
      recoverForm.classList.toggle('hidden', next !== 'recover');
      title.textContent = next === 'register' ? 'Создание аккаунта' : next === 'recover' ? 'Восстановление пароля' : 'Вход в панель';
      sub.textContent = next === 'register'
        ? 'Логин, e-mail и пароль. Доступы к серверам выдаёт администратор.'
        : next === 'recover'
          ? 'Укажите e-mail, привязанный к аккаунту, и новый пароль.'
          : 'Введите логин и пароль, выданные администратором.';
    };

    const switchMode = root.querySelector('#switch-mode');
    if (switchMode) {
      switchMode.addEventListener('click', (e) => {
        e.preventDefault();
        setMode(mode === 'register' ? 'login' : 'register');
      });
    }
    const switchRecover = root.querySelector('#switch-recover');
    if (switchRecover) {
      switchRecover.addEventListener('click', (e) => {
        e.preventDefault();
        setMode(mode === 'recover' ? 'login' : 'recover');
      });
    }

    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = root.querySelector('#login-btn');
      btn.disabled = true;
      try {
        await api.post('/api/auth/login', {
          username: loginForm.username.value.trim(),
          password: loginForm.password.value,
        });
        await ctx.afterLogin();
      } catch (err) {
        showError(err.message);
        btn.disabled = false;
      }
    });

    recoverForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api.post('/api/auth/recover', {
          email: recoverForm.email.value.trim(),
          password: recoverForm.password.value,
        });
        toast('Пароль сброшен', 'Теперь войдите с новым паролем', 'ok');
        setMode('login');
      } catch (err) {
        showError(err.message);
      }
    });

    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api.post('/api/auth/register', {
          username: registerForm.username.value.trim(),
          email: registerForm.email.value.trim(),
          password: registerForm.password.value,
        });
        toast('Аккаунт создан', 'Добро пожаловать в OmniDash', 'ok');
        await ctx.afterLogin();
      } catch (err) {
        showError(err.message);
      }
    });

    setTimeout(() => {
      const first = root.querySelector('#login-username');
      if (first) first.focus();
    }, 80);
  }

  return { html, mount, bare: true, title: 'Вход' };
}
