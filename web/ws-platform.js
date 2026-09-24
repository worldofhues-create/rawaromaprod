/* RAW AROMA — ws-platform module: admin / platform-operations views (role & permission
 * assignment). Depends on globals defined in shell.js (loaded first): tunnel, $, openSheet,
 * fLabel, toast, loadView, guessId, fetchAllPages.
 * UX-C: both dialogs now use the shared openSheet() modal (.xp-scrim/.xp-sheet, focus trap,
 * Escape) and .fld fields. They used to build a bespoke overlay whose <select> styled itself
 * via fStyle() — a helper no file defines, so both dialogs threw a ReferenceError on open. */
'use strict';
  /* ---------------- assign a role to a user (admin only — "only admin can give the role") ---------------- */
  function openAssignRole(user) {
    var m = openSheet({ id: 'ra-cform', tag: 'form', style: 'max-width:400px', title: 'Assign role', body:
      '<div style="font:var(--w-reg) var(--t-body)/1.3 var(--font-ui);color:var(--ink-3)">' + escHtml(user.userName || user.email || 'User') + '</div>' +
      '<label style="display:flex;flex-direction:column;gap:5px">' + fLabel('Role', true) + '<select id="ra-role" class="fld"><option value="">Select…</option></select></label>' +
      '<div id="ra-merr" role="alert" style="min-height:16px;font:var(--w-med) var(--t-cap)/var(--lh-cap) var(--font-ui);color:var(--red)"></div>' +
      '<button type="submit" id="ra-msave" class="btn p" style="width:100%;justify-content:center;height:var(--ch-touch-floor-coarse-pointer)">Assign</button>' });
    tunnel('/v1/roles?limit=100').then(function (res) {
      ((res.json && res.json.data) || []).forEach(function (role) { var v = role.roleId != null ? role.roleId : guessId(role); var l = role.roleName || role.roleCode || (v ? String(v).slice(0, 8) : ''); if (v) { var o = document.createElement('option'); o.value = v; o.textContent = l; $('ra-role').appendChild(o); } });
    }).catch(function () {});
    m.sheet.onsubmit = function (e) {
      e.preventDefault(); var roleId = $('ra-role').value; if (!roleId) { $('ra-merr').textContent = 'Pick a role.'; return; }
      var save = $('ra-msave'); save.disabled = true; save.textContent = 'Assigning…';
      tunnel('/v1/user-roles', { method: 'POST', body: { userId: user.userId, roleId: roleId } }).then(function (res) {
        if (res.status >= 400) { save.disabled = false; save.textContent = 'Assign'; $('ra-merr').textContent = (res.json && res.json.error && res.json.error.message) || ('Failed (' + res.status + ')'); return; }
        m.close(); toast('Role assigned', 'good'); loadView();
      }).catch(function () { save.disabled = false; save.textContent = 'Assign'; $('ra-merr').textContent = 'Can\'t connect. Try again.'; });
    };
  }
  /* assign a permission to a role (admin-gated — the RBAC operation that had no screen) */
  function openAssignPerm(role) {
    var m = openSheet({ id: 'ra-cform', tag: 'form', style: 'max-width:440px', title: 'Assign permission', body:
      '<div style="font:var(--w-reg) var(--t-body)/1.3 var(--font-ui);color:var(--ink-3)">' + escHtml(role.roleName || role.roleCode || 'Role') + '</div>' +
      '<label style="display:flex;flex-direction:column;gap:5px">' + fLabel('Permission', true) + '<select id="ra-perm" class="fld"><option value="">Loading…</option></select></label>' +
      '<div id="ra-merr" role="alert" style="min-height:16px;font:var(--w-med) var(--t-cap)/var(--lh-cap) var(--font-ui);color:var(--red)"></div>' +
      '<button type="submit" id="ra-msave" class="btn p" style="width:100%;justify-content:center;height:var(--ch-touch-floor-coarse-pointer)">Assign</button>' });
    fetchAllPages('/v1/permissions', function (perms) {
      var sel = $('ra-perm'); if (!sel) return;
      sel.innerHTML = '<option value="">Select…</option>' + perms.map(function (p) { var v = p.permissionId != null ? p.permissionId : guessId(p); var l = p.permissionCode || p.permissionName || (v ? String(v).slice(0, 8) : ''); return v ? '<option value="' + v + '">' + l + '</option>' : ''; }).join('');
    });
    m.sheet.onsubmit = function (e) {
      e.preventDefault(); var pid = $('ra-perm').value; if (!pid) { $('ra-merr').textContent = 'Pick a permission.'; return; }
      var rid = role.roleId != null ? role.roleId : guessId(role);
      var save = $('ra-msave'); save.disabled = true; save.textContent = 'Assigning…';
      tunnel('/v1/role-permissions', { method: 'POST', body: { roleId: rid, permissionId: pid } }).then(function (res) {
        if (res.status >= 400) { save.disabled = false; save.textContent = 'Assign'; $('ra-merr').textContent = (res.json && res.json.error && res.json.error.message) || ('Failed (' + res.status + ')'); return; }
        m.close(); toast('Permission assigned', 'good');
      }).catch(function () { save.disabled = false; save.textContent = 'Assign'; $('ra-merr').textContent = 'Can\'t connect. Try again.'; });
    };
  }
