/*!
 * SocialPilot lead form embed.
 * Usage:
 *   <div data-socialpilot-form="lf_xxxxxxxx"></div>
 *   <script src="https://YOUR-APP-DOMAIN/embed/form.js" async></script>
 * Renders inside a shadow root so the host page's CSS can't break it (and vice versa).
 * All text from the form config is inserted with textContent, never as HTML.
 */
(function () {
  'use strict';
  var script = document.currentScript;
  var base = script && script.src ? new URL(script.src).origin : '';
  if (!base) return;

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) for (var k in attrs) if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== false) node.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    if (text) node.textContent = text;
    return node;
  }

  function utm() {
    var out = {};
    try {
      var q = new URLSearchParams(window.location.search);
      ['utm_source', 'utm_medium', 'utm_campaign'].forEach(function (k) { if (q.get(k)) out[k] = q.get(k); });
    } catch (e) { /* old browser */ }
    return out;
  }

  var css =
    ':host{all:initial;display:block}' +
    '.f{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:15px;line-height:1.45;color:#1c2433;max-width:520px}' +
    '.t{font-size:20px;font-weight:600;margin:0 0 4px}.d{margin:0 0 16px;color:#4a5568}' +
    'label{display:block;font-weight:500;margin:12px 0 4px}.r{color:#b42318;margin-left:2px}' +
    'input,textarea,select{box-sizing:border-box;width:100%;font:inherit;color:inherit;padding:9px 11px;border:1px solid #cbd2dc;border-radius:8px;background:#fff}' +
    'textarea{min-height:96px;resize:vertical}input:focus,textarea:focus,select:focus{outline:2px solid var(--a);outline-offset:1px;border-color:var(--a)}' +
    '.e{color:#b42318;font-size:13px;margin-top:4px}.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}' +
    'button{margin-top:16px;font:inherit;font-weight:600;color:#fff;background:var(--a);border:0;border-radius:8px;padding:10px 18px;cursor:pointer}' +
    'button[disabled]{opacity:.6;cursor:default}.ok{padding:16px;border-radius:8px;background:#ecfdf3;color:#05603a}' +
    '.err{margin-top:12px;color:#b42318}.p{margin-top:14px;font-size:12px;color:#8a94a6}';

  function render(host, cfg) {
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var style = el('style'); style.textContent = css; root.appendChild(style);
    var wrap = el('div', { class: 'f' });
    wrap.style.setProperty('--a', /^#[0-9a-fA-F]{6}$/.test(cfg.accentColor) ? cfg.accentColor : '#0f766e');
    if (cfg.title) wrap.appendChild(el('p', { class: 't' }, cfg.title));
    if (cfg.description) wrap.appendChild(el('p', { class: 'd' }, cfg.description));
    var form = el('form', { novalidate: true });
    var inputs = {};
    cfg.fields.forEach(function (f) {
      var id = 'sp-' + cfg.key + '-' + f.key;
      var label = el('label', { for: id }, f.label);
      if (f.required) label.appendChild(el('span', { class: 'r', 'aria-hidden': 'true' }, '*'));
      form.appendChild(label);
      var input;
      if (f.type === 'textarea') input = el('textarea', { id: id, name: f.key });
      else if (f.type === 'select') {
        input = el('select', { id: id, name: f.key });
        input.appendChild(el('option', { value: '' }, 'Choose…'));
        (f.options || []).forEach(function (o) { input.appendChild(el('option', { value: o }, o)); });
      } else input = el('input', { id: id, name: f.key, type: f.type === 'phone' ? 'tel' : f.type === 'email' ? 'email' : 'text', autocomplete: f.key === 'name' ? 'name' : f.key === 'email' ? 'email' : f.key === 'phone' ? 'tel' : f.key === 'company' ? 'organization' : 'off' });
      if (f.required) input.setAttribute('aria-required', 'true');
      var err = el('div', { class: 'e', id: id + '-e', role: 'alert' });
      input.setAttribute('aria-describedby', id + '-e');
      form.appendChild(input); form.appendChild(err);
      inputs[f.key] = { input: input, err: err };
    });
    // Honeypot: hidden from people, often filled by bots.
    var hp = el('div', { class: 'hp', 'aria-hidden': 'true' });
    hp.appendChild(el('input', { name: 'website', tabindex: '-1', autocomplete: 'off' }));
    form.appendChild(hp);
    var button = el('button', { type: 'submit' }, cfg.submitLabel || 'Send');
    var status = el('div', { class: 'err', role: 'status' });
    form.appendChild(button); form.appendChild(status);
    wrap.appendChild(form);
    if (cfg.poweredBy) wrap.appendChild(el('p', { class: 'p' }, 'Powered by ' + cfg.poweredBy));
    root.appendChild(wrap);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      status.textContent = '';
      var payload = { fields: {}, pageUrl: window.location.href, website: hp.firstChild.value };
      var bad = false;
      cfg.fields.forEach(function (f) {
        var v = inputs[f.key].input.value.trim();
        inputs[f.key].err.textContent = '';
        if (f.required && !v) { inputs[f.key].err.textContent = f.label + ' is required'; bad = true; }
        payload.fields[f.key] = v;
      });
      if (bad) return;
      var u = utm(); for (var k in u) payload[k] = u[k];
      button.disabled = true;
      fetch(base + '/api/v1/public/forms/' + encodeURIComponent(cfg.key) + '/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
        .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
        .then(function (r) {
          button.disabled = false;
          if (r.ok) {
            if (r.body.redirectUrl && /^https?:\/\//.test(r.body.redirectUrl)) { window.location.href = r.body.redirectUrl; return; }
            var done = el('div', { class: 'ok', role: 'status' }, r.body.message || cfg.successMessage);
            form.replaceWith(done);
            return;
          }
          var details = (r.body.error && r.body.error.details) || [];
          details.forEach(function (d) { if (inputs[d.path]) inputs[d.path].err.textContent = d.message; });
          status.textContent = (r.body.error && r.body.error.message) || 'Something went wrong. Please try again.';
        })
        .catch(function () { button.disabled = false; status.textContent = 'Could not send. Check your connection and try again.'; });
    });
  }

  function init(host) {
    if (host.getAttribute('data-sp-ready')) return;
    host.setAttribute('data-sp-ready', '1');
    var key = host.getAttribute('data-socialpilot-form');
    if (!/^lf_[A-Za-z0-9_-]{8,40}$/.test(key || '')) return;
    fetch(base + '/api/v1/public/forms/' + encodeURIComponent(key))
      .then(function (res) { if (!res.ok) throw new Error('form unavailable'); return res.json(); })
      .then(function (cfg) { render(host, cfg); })
      .catch(function () { host.textContent = 'This form is not available right now.'; });
  }

  function scan() { Array.prototype.forEach.call(document.querySelectorAll('[data-socialpilot-form]'), init); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan); else scan();
})();
