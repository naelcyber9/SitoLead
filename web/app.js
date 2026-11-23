// Sitolead : application (recherche, déblocage, fiche prospect, pipeline, abonnement, profil).
'use strict';

(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (n) => Number(n).toLocaleString('fr-FR');
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
  const today = () => new Date().toISOString().slice(0, 10);

  const STATUS_LABELS = {
    a_contacter: 'À contacter',
    contacte: 'Contacté',
    relance: 'Relancé',
    rdv: 'Rendez-vous',
    devis: 'Devis envoyé',
    gagne: 'Gagné',
    perdu: 'Perdu',
  };
  const VIEWS = { search: 'recherche', leads: 'prospects', billing: 'abonnement', profile: 'profil' };
  const HASH_TO_VIEW = Object.fromEntries(Object.entries(VIEWS).map(([k, v]) => [v, k]));

  const state = {
    config: null,
    user: null,
    view: null,
    search: { city: null, trade: '', status: 'all', min: 0, offset: 0, items: [], total: 0, polls: 0 },
    leads: [],
    leadFilter: '',
  };

  const store = {
    get(k) {
      try {
        return JSON.parse(localStorage.getItem(`sitolead.${k}`) ?? 'null');
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(`sitolead.${k}`, JSON.stringify(v));
      } catch {
        /* stockage indisponible : sans conséquence */
      }
    },
  };

  // --- API -------------------------------------------------------------------------

  async function api(path, { method = 'GET', body } = {}) {
    const init = { method, credentials: 'same-origin', headers: {} };
    if (method !== 'GET') {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body ?? {});
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch {
      throw Object.assign(new Error('Connexion impossible, vérifiez votre réseau'), { status: 0 });
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* réponse vide */
    }
    if (!res.ok) throw Object.assign(new Error(data?.error || `Erreur ${res.status}`), { status: res.status, code: data?.code });
    return data;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }

  function handleError(e) {
    if (e.status === 401) return showAuth('login');
    if (e.status === 402 && e.code === 'upgrade') return openUpgrade(e.message);
    toast(e.message);
  }

  // --- Navigation --------------------------------------------------------------------

  function setUser(user) {
    state.user = user;
    const pill = $('#quota-pill');
    if (!user) {
      pill.hidden = true;
      $('#app-nav').hidden = true;
      return;
    }
    $('#app-nav').hidden = false;
    const q = user.quota;
    pill.hidden = false;
    pill.textContent = q.plan === 'free' ? `${q.remaining} / ${q.limit} offertes` : `${fmt(q.remaining)} restantes ce mois`;
    pill.classList.toggle('low', q.remaining <= Math.max(1, Math.round(q.limit * 0.1)));
  }

  function hideAll() {
    $('#boot').hidden = true;
    $$('main > section').forEach((s) => (s.hidden = true));
  }

  function showAuth(tab = 'signup') {
    setUser(null);
    hideAll();
    $('#view-auth').hidden = false;
    selectAuthTab(tab);
  }

  function selectAuthTab(tab) {
    const signup = tab === 'signup';
    $('#tab-signup').setAttribute('aria-selected', String(signup));
    $('#tab-login').setAttribute('aria-selected', String(!signup));
    $('#form-signup').hidden = !signup;
    $('#form-login').hidden = signup;
    $((signup ? '#form-signup' : '#form-login') + ' input[name=email]').focus();
  }

  function go(view, { push = true } = {}) {
    if (!state.user) return showAuth();
    state.view = view;
    hideAll();
    $(`#view-${view}`).hidden = false;
    $$('#app-nav button').forEach((b) => (b.dataset.view === view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
    if (push && location.hash !== `#${VIEWS[view]}`) history.replaceState(null, '', `#${VIEWS[view]}`);
    if (view === 'leads') loadLeads();
    if (view === 'billing') renderBilling();
    if (view === 'profile') renderProfile();
    window.scrollTo(0, 0);
  }

  // --- Authentification ---------------------------------------------------------------

  function bindAuth() {
    $('#tab-signup').addEventListener('click', () => selectAuthTab('signup'));
    $('#tab-login').addEventListener('click', () => selectAuthTab('login'));
    for (const id of ['signup', 'login']) {
      const form = $(`#form-${id}`);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const err = $('.form-error', form);
        err.textContent = '';
        const fd = new FormData(form);
        const body = { email: fd.get('email'), password: fd.get('password') };
        if (id === 'signup') body.terms = fd.get('terms') === 'on';
        const btn = $('button[type=submit]', form);
        btn.disabled = true;
        try {
          const { user } = await api(`/api/${id}`, { method: 'POST', body });
          setUser(user);
          form.reset();
          go(HASH_TO_VIEW[location.hash.slice(1)] ?? 'search');
          if (id === 'signup') toast('Compte créé : vos 5 entreprises offertes vous attendent');
          if (state.view === 'search' && state.search.city) runSearch();
        } catch (e) {
          err.textContent = e.message;
        } finally {
          btn.disabled = false;
        }
      });
    }
  }

  // --- Recherche ----------------------------------------------------------------------

  function bindSearch() {
    const sel = $('#trade-select');
    sel.innerHTML = state.config.trades.map((t) => `<option value="${h(t.slug)}">${h(t.label)}</option>`).join('');

    const saved = store.get('search');
    if (saved?.city?.code) state.search.city = saved.city;
    if (saved?.trade) state.search.trade = saved.trade;
    state.search.trade ||= state.config.trades[0].slug;
    sel.value = state.search.trade;
    if (state.search.city) $('#city-input').value = state.search.city.nom;

    bindCombo();

    $('#search-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!state.search.city || $('#city-input').value.trim() !== state.search.city.nom) {
        const first = await fetchCommunes($('#city-input').value);
        if (!first.length) return toast('Choisissez une ville dans la liste');
        state.search.city = { code: first[0].code, nom: first[0].nom };
        $('#city-input').value = first[0].nom;
      }
      state.search.trade = sel.value;
      store.set('search', { city: state.search.city, trade: state.search.trade });
      runSearch();
    });
    sel.addEventListener('change', () => state.search.city && $('#search-form').requestSubmit());
    $$('.chip').forEach((chip) =>
      chip.addEventListener('click', () => {
        state.search.status = chip.dataset.status;
        $$('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
        if (state.search.city) runSearch();
      }),
    );
    $('#min-select').addEventListener('change', (e) => {
      state.search.min = Number(e.target.value);
      if (state.search.city) runSearch();
    });
    $('#more-btn').addEventListener('click', () => runSearch({ append: true }));
    $('#results').addEventListener('click', onResultClick);
  }

  async function fetchCommunes(q) {
    if (q.trim().length < 2) return [];
    try {
      return (await api(`/api/communes?q=${encodeURIComponent(q.trim())}`)).items;
    } catch {
      return [];
    }
  }

  function bindCombo() {
    const input = $('#city-input');
    const list = $('#city-list');
    let items = [];
    let active = -1;
    let timer;
    let seq = 0;

    const close = () => {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      active = -1;
    };
    const render = () => {
      if (!items.length) return close();
      list.innerHTML = items
        .map(
          (c, i) =>
            `<li role="option" id="city-opt-${i}" data-i="${i}" aria-selected="${i === active}">${h(c.nom)} <span class="muted">(${h(c.codesPostaux?.[0] ?? c.departement)})</span></li>`,
        )
        .join('');
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      if (active >= 0) input.setAttribute('aria-activedescendant', `city-opt-${active}`);
    };
    const choose = (i) => {
      const c = items[i];
      if (!c) return;
      state.search.city = { code: c.code, nom: c.nom };
      input.value = c.nom;
      close();
      $('#search-form').requestSubmit();
    };

    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const mine = ++seq;
        const res = await fetchCommunes(input.value);
        if (mine !== seq) return;
        items = res;
        active = -1;
        render();
      }, 180);
    });
    input.addEventListener('keydown', (e) => {
      if (list.hidden) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        render();
      } else if (e.key === 'Enter' && active >= 0) {
        e.preventDefault();
        choose(active);
      } else if (e.key === 'Escape') close();
    });
    list.addEventListener('mousedown', (e) => {
      const li = e.target.closest('li');
      if (li) {
        e.preventDefault();
        choose(Number(li.dataset.i));
      }
    });
    input.addEventListener('blur', () => setTimeout(close, 120));
  }

  let searchSeq = 0;
  async function runSearch({ append = false, silent = false } = {}) {
    const s = state.search;
    if (!append) {
      s.offset = 0;
      if (!silent) s.polls = 0;
    }
    const mine = ++searchSeq;
    const results = $('#results');
    if (!append && !silent) {
      $('#results-head').hidden = true;
      $('#more-btn').hidden = true;
      results.innerHTML = `<div class="loading"><span class="spinner" aria-hidden="true"></span>Analyse des entreprises de ${h(s.city.nom)}… La première recherche peut prendre jusqu’à 30 secondes.</div>`;
    }
    const qs = new URLSearchParams({ city: s.city.code, trade: s.trade, status: s.status, min: String(s.min), offset: String(append ? s.offset : 0) });
    try {
      const data = await api(`/api/prospects?${qs}`);
      if (mine !== searchSeq) return;
      s.items = append ? [...s.items, ...data.items] : data.items;
      s.total = data.total;
      s.offset = s.items.length;
      if (state.user) setUser({ ...state.user, quota: data.quota });
      renderResults(data);
      const pending = data.items.some((p) => p.site_status === 'pending');
      if (pending && !append && s.polls < 6) {
        s.polls++;
        setTimeout(() => mine === searchSeq && state.view === 'search' && runSearch({ silent: true }), 7000);
      }
    } catch (e) {
      if (mine !== searchSeq) return;
      results.innerHTML = `<div class="empty">${h(e.message)}</div>`;
      handleError(e);
    }
  }

  function trade(slug) {
    return state.config.trades.find((t) => t.slug === slug);
  }

  function renderResults(data) {
    const s = state.search;
    const t = trade(s.trade);
    $('#results-head').hidden = false;
    $('#results-title').textContent = `${fmt(s.total)} ${t ? t.plural : 'entreprises'} à ${data.commune.nom}`;
    const sub = [];
    if (data.search?.fetched_at) sub.push(`Données mises à jour le ${fmtDate(data.search.fetched_at)}`);
    if (data.search?.errors?.length) sub.push(`Source partiellement indisponible : ${data.search.errors.join(' ; ')}`);
    $('#results-sub').textContent = sub.join(' · ');
    if (!s.items.length) {
      $('#results').innerHTML = `<div class="empty"><p><strong>Aucune entreprise pour ces critères.</strong></p><p>Essayez un autre métier, une commune voisine plus grande, ou retirez les filtres.</p></div>`;
      $('#more-btn').hidden = true;
      return;
    }
    $('#results').innerHTML = s.items.map(cardHtml).join('');
    $('#more-btn').hidden = s.items.length >= s.total;
  }

  const statusClass = (st) => (['none', 'social', 'down', 'unknown'].includes(st) ? 'tag-hot' : st === 'weak' ? 'tag-warn' : st === 'ok' ? 'tag-ok' : '');
  const scoreClass = (n) => (n >= 80 ? 'score-hot' : n >= 60 ? 'score-warm' : '');

  function ageLabel(created) {
    if (!created) return '';
    const d = new Date(created);
    const months = (new Date().getFullYear() - d.getFullYear()) * 12 + (new Date().getMonth() - d.getMonth());
    if (months > 24) return '';
    return months <= 0 ? 'créée ce mois-ci' : `créée il y a ${months} mois`;
  }

  function cardHtml(p) {
    const meta = [p.tradeLabel, [p.city, p.postal_code].filter(Boolean).join(' '), ageLabel(p.created_on)].filter(Boolean).join(' · ');
    const issues = p.issues.filter((i) => i.weight > 0).slice(0, 3);
    const quota = state.user?.quota;
    let actions;
    let contact = '';
    if (p.unlocked) {
      actions = `<button type="button" class="btn btn-sm" data-open="${h(p.id)}">Ouvrir la fiche</button>`;
      const bits = [];
      if (p.phone) bits.push(`<a href="tel:${h(p.phone.replace(/\s/g, ''))}">${h(p.phone)}</a>`);
      if (p.email) bits.push(`<a href="mailto:${h(p.email)}">${h(p.email)}</a>`);
      if (p.website) bits.push(`<a href="${h(safeUrl(p.website))}" target="_blank" rel="noopener nofollow">${h(p.website.replace(/^https?:\/\//, ''))}</a>`);
      contact = bits.length ? `<p class="contact">${bits.join(' · ')}</p>` : '';
    } else {
      const left = quota ? ` <span class="small">(${quota.remaining} restantes)</span>` : '';
      actions = `<button type="button" class="btn btn-sm" data-unlock="${h(p.id)}">Débloquer${left}</button>`;
    }
    return `<article class="card${p.unlocked ? ' unlocked' : ''}">
  <div class="score ${scoreClass(p.opportunity)}" title="Score d’opportunité sur 100" aria-label="Score d’opportunité ${p.opportunity} sur 100">${p.opportunity}</div>
  <div>
    <h3>${h(p.name)}</h3>
    <p class="meta">${h(meta)}</p>
    <p><span class="tag ${statusClass(p.site_status)}">${h(p.statusLabel)}</span>${p.audit_score !== null && p.site_status !== 'down' ? `<span class="tag">Site : ${p.audit_score}/100</span>` : ''}${
      p.hasPhone ? '<span class="tag">Téléphone</span>' : ''
    }${p.hasEmail ? '<span class="tag">Email</span>' : ''}${p.lead ? `<span class="tag tag-ok">${h(STATUS_LABELS[p.lead.status] ?? p.lead.status)}</span>` : ''}</p>
    ${issues.length ? `<ul class="issues">${issues.map((i) => `<li>${h(i.label)}</li>`).join('')}</ul>` : ''}
    ${contact}
  </div>
  <div class="actions">${actions}</div>
</article>`;
  }

  function safeUrl(u) {
    const v = /^https?:\/\//i.test(u) ? u : `http://${u}`;
    try {
      const parsed = new URL(v);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '#';
    } catch {
      return '#';
    }
  }

  async function onResultClick(e) {
    const unlock = e.target.closest('[data-unlock]');
    const open = e.target.closest('[data-open]');
    if (open) return openLead(open.dataset.open);
    if (!unlock) return;
    unlock.disabled = true;
    try {
      const data = await api(`/api/prospects/${encodeURIComponent(unlock.dataset.unlock)}/unlock`, { method: 'POST' });
      setUser({ ...state.user, quota: data.quota });
      const i = state.search.items.findIndex((p) => p.id === data.prospect.id);
      if (i >= 0) state.search.items[i] = data.prospect;
      $('#results').innerHTML = state.search.items.map(cardHtml).join('');
      openLead(data.prospect.id);
    } catch (err) {
      unlock.disabled = false;
      handleError(err);
    }
  }

  // --- Fiche prospect -----------------------------------------------------------------

  let currentLead = null;

  async function openLead(id) {
    const dlg = $('#lead-dialog');
    $('#lead-title').textContent = 'Chargement…';
    $('#lead-sub').textContent = '';
    $('#lead-body').innerHTML = '<div class="loading"><span class="spinner" aria-hidden="true"></span></div>';
    if (!dlg.open) dlg.showModal();
    try {
      const [{ lead }, { pitch, profileComplete }] = await Promise.all([
        api(`/api/leads/${encodeURIComponent(id)}`),
        api(`/api/leads/${encodeURIComponent(id)}/pitch`),
      ]);
      currentLead = lead;
      renderLead(lead, pitch, profileComplete);
    } catch (e) {
      dlg.close();
      handleError(e);
    }
  }

  function renderLead(p, pitch, profileComplete) {
    $('#lead-title').textContent = p.name;
    $('#lead-sub').textContent = [p.tradeLabel, p.city, `score ${p.opportunity}/100`].filter(Boolean).join(' · ');
    const facts = [
      ['Adresse', [p.address, p.postal_code, p.city].filter(Boolean).join(', ')],
      ['Téléphone', p.phone ? `<a href="tel:${h(p.phone.replace(/\s/g, ''))}">${h(p.phone)}</a>` : '<span class="muted">Non public : cherchez sa fiche Google</span>', true],
      ['Email', p.email ? `<a href="mailto:${h(p.email)}">${h(p.email)}</a>` : '<span class="muted">Non public</span>', true],
      ['Site', p.website ? `<a href="${h(safeUrl(p.website))}" target="_blank" rel="noopener nofollow">${h(p.website)}</a>` : '<span class="muted">Aucun</span>', true],
      ['État du site', `${p.statusLabel}${p.audit_score !== null && p.site_status !== 'down' ? ` (${p.audit_score}/100)` : ''}`],
      ['Création', p.created_on ? fmtDate(p.created_on) : ''],
      ['SIRET', p.siret ?? ''],
    ].filter(([, v]) => v);
    const q = encodeURIComponent(`${p.name} ${p.city ?? ''}`);
    const map = p.lat && p.lon ? ` · <a href="https://www.openstreetmap.org/?mlat=${p.lat}&amp;mlon=${p.lon}#map=18/${p.lat}/${p.lon}" target="_blank" rel="noopener">Voir sur la carte</a>` : '';
    const issues = p.issues.filter((i) => i.weight > 0);
    const statuses = state.config.leadStatuses.map((s) => `<option value="${s}"${p.lead.status === s ? ' selected' : ''}>${h(STATUS_LABELS[s] ?? s)}</option>`).join('');
    const mailto = p.email ? `mailto:${encodeURIComponent(p.email)}?subject=${encodeURIComponent(pitch.subject)}&body=${encodeURIComponent(pitch.email)}` : '';

    $('#lead-body').innerHTML = `
${profileComplete ? '' : '<p class="notice warn">Complétez votre <button type="button" class="btn-link" data-goto="profile">profil</button> pour signer vos messages avec votre nom et votre téléphone.</p>'}
<dl class="facts">${facts.map(([k, v, raw]) => `<dt>${h(k)}</dt><dd>${raw ? v : h(v)}</dd>`).join('')}</dl>
<p class="small"><a href="https://www.google.com/search?q=${q}" target="_blank" rel="noopener">Rechercher sur Google</a>${map}</p>
${issues.length ? `<h3 class="section-title">Ce qui lui fait perdre des clients</h3><ul class="issues">${issues.map((i) => `<li>${h(i.label)}</li>`).join('')}</ul>` : ''}
<h3 class="section-title">Message de prospection</h3>
<div class="tabs" role="tablist" aria-label="Type de message">
  <button type="button" role="tab" aria-selected="true" data-pitch="email">Email</button>
  <button type="button" role="tab" aria-selected="false" data-pitch="call">Appel</button>
  <button type="button" role="tab" aria-selected="false" data-pitch="sms">SMS</button>
</div>
<p class="small muted" id="pitch-subject">Objet : ${h(pitch.subject)}</p>
<pre class="pitch-text" id="pitch-text" tabindex="0">${h(pitch.email)}</pre>
<div class="row">
  <button type="button" class="btn btn-sm btn-dark" id="copy-pitch">Copier</button>
  ${mailto ? `<a class="btn btn-sm btn-ghost" href="${h(mailto)}">Ouvrir dans ma messagerie</a>` : ''}
</div>
<h3 class="section-title">Suivi</h3>
<form id="lead-form" novalidate>
  <div class="grid-2">
    <label class="field"><span>Statut</span><select name="status">${statuses}</select></label>
    <label class="field"><span>Prochaine action</span><input type="date" name="next_action_at" value="${h(p.lead.next_action_at ?? '')}"></label>
  </div>
  <label class="field"><span>Notes</span><textarea name="note" maxlength="5000" placeholder="Ex. rappeler mardi, intéressé par la prise de rendez-vous en ligne">${h(p.lead.note)}</textarea></label>
  <button class="btn btn-sm" type="submit">Enregistrer le suivi</button>
</form>`;

    const texts = { email: pitch.email, call: pitch.call, sms: pitch.sms };
    let current = 'email';
    $$('[data-pitch]', $('#lead-body')).forEach((b) =>
      b.addEventListener('click', () => {
        current = b.dataset.pitch;
        $$('[data-pitch]', $('#lead-body')).forEach((x) => x.setAttribute('aria-selected', String(x === b)));
        $('#pitch-text').textContent = texts[current];
        $('#pitch-subject').hidden = current !== 'email';
      }),
    );
    $('#copy-pitch').addEventListener('click', async () => {
      const text = current === 'email' ? `Objet : ${pitch.subject}\n\n${texts.email}` : texts[current];
      try {
        await navigator.clipboard.writeText(text);
        toast('Message copié');
      } catch {
        toast('Copie impossible : sélectionnez le texte manuellement');
      }
    });
    $('[data-goto]', $('#lead-body'))?.addEventListener('click', () => {
      $('#lead-dialog').close();
      go('profile');
    });
    $('#lead-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      try {
        const { lead } = await api(`/api/leads/${encodeURIComponent(currentLead.id)}`, {
          method: 'PATCH',
          body: { status: fd.get('status'), next_action_at: fd.get('next_action_at') || null, note: fd.get('note') },
        });
        currentLead = lead;
        toast('Suivi enregistré');
        const i = state.search.items.findIndex((x) => x.id === lead.id);
        if (i >= 0) {
          state.search.items[i] = lead;
          $('#results').innerHTML = state.search.items.map(cardHtml).join('');
        }
        if (state.view === 'leads') loadLeads();
      } catch (e) {
        handleError(e);
      }
    });
  }

  // --- Pipeline -----------------------------------------------------------------------

  async function loadLeads() {
    $('#leads').innerHTML = '<div class="loading"><span class="spinner" aria-hidden="true"></span></div>';
    try {
      const data = await api('/api/leads');
      state.leads = data.items;
      setUser({ ...state.user, quota: data.quota });
      renderLeads();
    } catch (e) {
      handleError(e);
    }
  }

  function renderLeads() {
    const leads = state.leads;
    const due = leads.filter((l) => l.lead.next_action_at && l.lead.next_action_at <= today() && !['gagne', 'perdu'].includes(l.lead.status));
    const count = (s) => leads.filter((l) => l.lead.status === s).length;
    $('#kpis').innerHTML = [
      [leads.length, 'prospects débloqués'],
      [due.length, 'à relancer aujourd’hui'],
      [count('rdv') + count('devis'), 'en rendez-vous ou devis'],
      [count('gagne'), 'clients gagnés'],
    ]
      .map(([n, l]) => `<div class="kpi"><strong>${fmt(n)}</strong><span>${h(l)}</span></div>`)
      .join('');
    const list = state.leadFilter ? leads.filter((l) => l.lead.status === state.leadFilter) : leads;
    if (!leads.length) {
      $('#leads').innerHTML = `<div class="empty"><p><strong>Aucun prospect pour l’instant.</strong></p><p>Lancez une recherche et débloquez vos premières entreprises.</p><button type="button" class="btn" data-goto="search">Trouver des clients</button></div>`;
      return;
    }
    if (!list.length) {
      $('#leads').innerHTML = '<div class="empty">Aucun prospect avec ce statut.</div>';
      return;
    }
    const statuses = state.config.leadStatuses;
    $('#leads').innerHTML = `<table class="lead-table">
<thead><tr><th scope="col">Entreprise</th><th scope="col">Contact</th><th scope="col">Site</th><th scope="col">Statut</th><th scope="col">Prochaine action</th></tr></thead>
<tbody>${list
      .map((l) => {
        const isDue = l.lead.next_action_at && l.lead.next_action_at <= today() && !['gagne', 'perdu'].includes(l.lead.status);
        return `<tr>
  <td><button type="button" class="btn-link" data-open="${h(l.id)}"><strong>${h(l.name)}</strong></button><br><span class="small muted">${h(l.tradeLabel)} · ${h(l.city ?? '')}</span></td>
  <td class="small">${l.phone ? `<a href="tel:${h(l.phone.replace(/\s/g, ''))}">${h(l.phone)}</a>` : ''}${l.phone && l.email ? '<br>' : ''}${l.email ? `<a href="mailto:${h(l.email)}">${h(l.email)}</a>` : ''}${!l.phone && !l.email ? '<span class="muted">À trouver</span>' : ''}</td>
  <td><span class="tag ${statusClass(l.site_status)}">${h(l.statusLabel)}</span></td>
  <td><select data-status-for="${h(l.id)}" aria-label="Statut de ${h(l.name)}">${statuses
    .map((s) => `<option value="${s}"${l.lead.status === s ? ' selected' : ''}>${h(STATUS_LABELS[s] ?? s)}</option>`)
    .join('')}</select></td>
  <td class="${isDue ? 'due' : ''}">${l.lead.next_action_at ? h(new Date(l.lead.next_action_at).toLocaleDateString('fr-FR')) : '<span class="muted">—</span>'}${isDue ? ' · à faire' : ''}</td>
</tr>`;
      })
      .join('')}</tbody></table>`;
  }

  function bindLeads() {
    const filter = $('#lead-filter');
    filter.innerHTML += state.config.leadStatuses.map((s) => `<option value="${s}">${h(STATUS_LABELS[s] ?? s)}</option>`).join('');
    filter.addEventListener('change', () => {
      state.leadFilter = filter.value;
      renderLeads();
    });
    $('#leads').addEventListener('click', (e) => {
      const open = e.target.closest('[data-open]');
      if (open) openLead(open.dataset.open);
      if (e.target.closest('[data-goto]')) go('search');
    });
    $('#leads').addEventListener('change', async (e) => {
      const sel = e.target.closest('[data-status-for]');
      if (!sel) return;
      try {
        const { lead } = await api(`/api/leads/${encodeURIComponent(sel.dataset.statusFor)}`, { method: 'PATCH', body: { status: sel.value } });
        const i = state.leads.findIndex((l) => l.id === lead.id);
        if (i >= 0) state.leads[i] = lead;
        renderLeads();
        toast(`Statut : ${STATUS_LABELS[lead.lead.status]}`);
      } catch (err) {
        handleError(err);
      }
    });
    $('#csv-btn').addEventListener('click', () => {
      if (!state.user.csv) return openUpgrade('L’export CSV est inclus dans les offres Pro et Agence.');
      location.href = '/api/leads.csv';
    });
  }

  // --- Abonnement ---------------------------------------------------------------------

  function planCards(container, { compact = false } = {}) {
    const u = state.user;
    const plans = state.config.plans.filter((p) => !compact || p.id !== 'free');
    container.innerHTML = plans
      .map((p) => {
        const current = u.plan === p.id;
        let action;
        if (p.id === 'free') action = current ? '<p class="small muted">Votre offre actuelle</p>' : '';
        else if (current) action = '<button type="button" class="btn btn-ghost" data-portal>Gérer mon abonnement</button>';
        else action = `<button type="button" class="btn${p.id === 'pro' ? '' : ' btn-dark'}" data-plan="${p.id}">${u.plan === 'free' ? 'Choisir' : 'Passer à'} ${h(p.name)}</button>`;
        return `<article class="plan${p.id === 'pro' && !current ? ' plan-featured' : ''}${current ? ' plan-current' : ''}">
  ${current ? '<p class="plan-flag">Votre offre</p>' : p.id === 'pro' ? '<p class="plan-flag">Le plus choisi</p>' : ''}
  <h3>${h(p.name)}</h3>
  <p class="price"><strong>${p.priceEur} €</strong><span>${p.monthly ? ' HT / mois' : ' pour toujours'}</span></p>
  <ul class="checks">${p.features.map((f) => `<li>${h(f)}</li>`).join('')}</ul>
  ${action}
</article>`;
      })
      .join('');
  }

  async function startCheckout(plan, btn) {
    btn.disabled = true;
    try {
      const { url } = await api('/api/billing/checkout', { method: 'POST', body: { plan } });
      location.href = url;
    } catch (e) {
      btn.disabled = false;
      handleError(e);
    }
  }

  async function openPortal(btn) {
    btn.disabled = true;
    try {
      const { url } = await api('/api/billing/portal', { method: 'POST' });
      location.href = url;
    } catch (e) {
      btn.disabled = false;
      handleError(e);
    }
  }

  function onPlanClick(e) {
    const plan = e.target.closest('[data-plan]');
    if (plan) return startCheckout(plan.dataset.plan, plan);
    const portal = e.target.closest('[data-portal]');
    if (portal) return openPortal(portal);
  }

  function renderBilling() {
    const u = state.user;
    const q = u.quota;
    $('#plan-name').textContent = `Offre ${u.planName}`;
    const meta = [];
    if (u.plan_status === 'past_due') meta.push('paiement en échec : mettez à jour votre carte');
    if (u.period_end && u.plan !== 'free') meta.push(`renouvellement le ${fmtDate(u.period_end)}`);
    $('#plan-meta').textContent = meta.length ? `· ${meta.join(' · ')}` : '';
    $('#quota-bar').style.width = `${Math.min(100, (q.used / Math.max(1, q.limit)) * 100)}%`;
    $('#quota-text').textContent =
      q.plan === 'free'
        ? `${q.used} entreprise${q.used > 1 ? 's' : ''} débloquée${q.used > 1 ? 's' : ''} sur ${q.limit} offertes.`
        : `${fmt(q.used)} sur ${fmt(q.limit)} entreprises débloquées ce mois-ci. Remise à zéro le ${fmtDate(q.resetsAt)}.`;
    $('#portal-btn').hidden = !u.hasBilling;
    if (!state.config.billing) {
      $('#billing-notice').innerHTML = '<p class="notice warn">Le paiement en ligne n’est pas encore activé sur ce serveur.</p>';
    }
    planCards($('#plans'));
  }

  function openUpgrade(message) {
    $('#upgrade-text').textContent = message;
    planCards($('#upgrade-plans'), { compact: true });
    const dlg = $('#upgrade-dialog');
    if ($('#lead-dialog').open) $('#lead-dialog').close();
    if (!dlg.open) dlg.showModal();
  }

  async function handlePaymentReturn() {
    const params = new URLSearchParams(location.search);
    const status = params.get('paiement');
    if (!status) return;
    history.replaceState(null, '', location.pathname + location.hash);
    if (status === 'annule') {
      $('#billing-notice').innerHTML = '<p class="notice warn">Paiement annulé : aucun montant n’a été débité.</p>';
      return;
    }
    $('#billing-notice').innerHTML = '<p class="notice">Merci ! Votre abonnement est en cours d’activation…</p>';
    // Le webhook Stripe peut arriver quelques secondes après la redirection.
    for (let i = 0; i < 8; i++) {
      const { user } = await api('/api/me');
      if (user && user.plan !== 'free') {
        setUser(user);
        $('#billing-notice').innerHTML = `<p class="notice">Abonnement ${h(user.planName)} activé : ${fmt(user.quota.limit)} entreprises par mois. Bonne prospection !</p>`;
        if (state.view === 'billing') renderBilling();
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    $('#billing-notice').innerHTML = '<p class="notice warn">Paiement reçu, activation en attente. Rechargez la page dans une minute.</p>';
  }

  // --- Profil -------------------------------------------------------------------------

  function renderProfile() {
    const f = $('#profile-form');
    for (const k of ['full_name', 'agency_name', 'phone', 'website']) f.elements[k].value = state.user[k] ?? '';
    $('#account-email').textContent = state.user.email;
  }

  function bindProfile() {
    $('#profile-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      const err = $('.form-error', f);
      err.textContent = '';
      const body = Object.fromEntries(['full_name', 'agency_name', 'phone', 'website'].map((k) => [k, f.elements[k].value]));
      try {
        const { user } = await api('/api/me', { method: 'PATCH', body });
        setUser(user);
        toast('Profil enregistré');
      } catch (e) {
        err.textContent = e.message;
      }
    });
    $('#logout-btn').addEventListener('click', async () => {
      await api('/api/logout', { method: 'POST' }).catch(() => {});
      location.href = '/';
    });
    $('#delete-btn').addEventListener('click', () => $('#delete-dialog').showModal());
    $('#delete-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = $('.form-error', ev.target);
      err.textContent = '';
      try {
        await api('/api/me', { method: 'DELETE', body: { password: ev.target.elements.password.value } });
        location.href = '/';
      } catch (e) {
        err.textContent = e.message;
      }
    });
  }

  // --- Démarrage ----------------------------------------------------------------------

  function bindGlobal() {
    $$('#app-nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
    $$('dialog').forEach((d) => {
      d.addEventListener('click', (e) => {
        if (e.target === d || e.target.closest('[data-close]')) d.close();
      });
    });
    $('#plans').addEventListener('click', onPlanClick);
    $('#upgrade-plans').addEventListener('click', onPlanClick);
    $('#portal-btn').addEventListener('click', (e) => openPortal(e.currentTarget));
    window.addEventListener('hashchange', () => {
      const h2 = location.hash.slice(1);
      if (!state.user) return showAuth(h2 === 'connexion' ? 'login' : 'signup');
      if (HASH_TO_VIEW[h2] && HASH_TO_VIEW[h2] !== state.view) go(HASH_TO_VIEW[h2], { push: false });
    });
  }

  async function boot() {
    try {
      const [config, me] = await Promise.all([api('/api/config'), api('/api/me')]);
      state.config = config;
      bindAuth();
      bindSearch();
      bindLeads();
      bindProfile();
      bindGlobal();
      const hash = location.hash.slice(1);
      if (!me.user) return showAuth(hash === 'inscription' ? 'signup' : hash === 'connexion' ? 'login' : 'signup');
      setUser(me.user);
      go(HASH_TO_VIEW[hash] ?? 'search', { push: true });
      handlePaymentReturn().catch(() => {});
      if (state.view === 'search' && state.search.city) runSearch();
    } catch (e) {
      $('#boot').innerHTML = `<p class="empty">${h(e.message)}</p>`;
    }
  }

  boot();
})();
