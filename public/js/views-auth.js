// Экран входа и регистрации.
import { api } from './api.js';
import { icon, logoMark } from './icons.js';
import { esc, toast } from './ui.js';

export function loginView(ctx) {
  const meta = ctx.meta || {};
  const demo = (meta.demo && meta.demo.logins) || [];
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
        <h1 class="auth-title">Панель, которая<br/>заменяет <span>Pterodactyl</span></h1>
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

        ${meta.registrationOpen ? `<div class="auth-alt">Нет аккаунта? <a href="#" id="switch-mode">Зарегистрироваться</a></div>` : `<div class="auth-alt">Регистрация закрыта — аккаунт выдаёт администратор.</div>`}

        ${demo.length ? `
        <div class="demo-box">
          <div class="t">${icon('sparkles', 12)} демо-доступ</div>
          ${demo.map((d) => `
            <div class="demo-row">
              <code>${esc(d.username)}</code><span class="dim">/</span><code>${esc(d.password)}</code>
              <span class="pill ${d.role === 'admin' ? 'accent' : ''}" style="height:19px;font-size:10px">${d.role}</span>
              <button class="btn sm ghost" data-fill="${esc(d.username)}" data-pass="${esc(d.password)}">заполнить</button>
            </div>`).join('')}
        </div>` : ''}
      </div>
    </section>
  </div>`;

  function mount(root) {
    const loginForm = root.querySelector('#login-form');
    const registerForm = root.querySelector('#register-form');
    const title = root.querySelector('#auth-title');
    const sub = root.querySelector('#auth-sub');
    const error = root.querySelector('#auth-error');
    let mode = 'login';

    const showError = (message) => {
      error.textContent = message;
      error.classList.add('show');
      setTimeout(() => error.classList.remove('show'), 5000);
    };

    root.querySelectorAll('[data-fill]').forEach((btn) => {
      btn.addEventListener('click', () => {
        root.querySelector('#login-username').value = btn.dataset.fill;
        root.querySelector('#login-password').value = btn.dataset.pass;
        root.querySelector('#login-password').focus();
      });
    });

    const switchMode = root.querySelector('#switch-mode');
    if (switchMode) {
      switchMode.addEventListener('click', (e) => {
        e.preventDefault();
        mode = mode === 'login' ? 'register' : 'login';
        const isRegister = mode === 'register';
        loginForm.classList.toggle('hidden', isRegister);
        registerForm.classList.toggle('hidden', !isRegister);
        title.textContent = isRegister ? 'Создание аккаунта' : 'Вход в панель';
        sub.textContent = isRegister ? 'Логин, e-mail и пароль. Доступы к серверам выдаёт администратор.' : 'Введите логин и пароль, выданные администратором.';
        switchMode.textContent = isRegister ? 'У меня уже есть аккаунт' : 'Зарегистрироваться';
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
