/* RAW AROMA — ws-platform module: admin / platform-operations views (role & permission
 * assignment). Depends on globals defined in shell.js (loaded first): tunnel, $, fStyle,
 * toast, setTheme, loadView, guessId, fetchAllPages. Mechanical extract — no behaviour
 * change. */
'use strict';
  /* ---------------- assign a role to a user (admin only — "only admin can give the role") ---------------- */
  function openAssignRole(user) {
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:250;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px';
    ov.innerHTML = '<form id="ra-cform" style="width:100%;max-width:400px;background:var(--surface);border:1px solid var(--cbord);backdrop-filter:var(--cblur);border-radius:22px;box-shadow:var(--rai);padding:24px 26px">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px"><div style="font-weight:800;font-size:17px;flex:1">Assign role</div><button type="button" id="ra-mclose" style="border:none;background:var(--well);box-shadow:var(--ins-sm);color:var(--t2);width:32px;height:32px;border-radius:10px;cursor:pointer;font-size:17px">&times;</button></div>' +
      '<div style="font-size:12.5px;color:var(--t3);margin-bottom:16px">' + (user.userName || user.email || 'User') + '</div>' +
      '<label style="display:block;font-size:12px;font-weight:700;color:var(--t2);margin-bottom:6px">Role <span style="color:#C0492E">*</span></label>' +
      '<select id="ra-role" style="' + fStyle() + '"><option value="">Select…</option></select>' +
      '<div id="ra-merr" style="min-height:16px;font-size:12.5px;color:#C0492E;font-weight:600;margin:8px 0 10px"></div>' +
      '<button type="submit" id="ra-msave" style="width:100%;padding:13px;border:none;border-radius:14px;background:var(--accent);color:#fff;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:var(--rai-sm)">Assign</button></form>';
    document.body.appendChild(ov); setTheme();
    function close() { if (ov.parentNode) ov.remove(); }
    $('ra-mclose').onclick = close; ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    tunnel('/v1/roles?limit=100').then(function (res) {
      ((res.json && res.json.data) || []).forEach(function (role) { var v = role.roleId != null ? role.roleId : guessId(role); var l = role.roleName || role.roleCode || (v ? String(v).slice(0, 8) : ''); if (v) { var o = document.createElement('option'); o.value = v; o.textContent = l; $('ra-role').appendChild(o); } });
    }).catch(function () {});
    $('ra-cform').onsubmit = function (e) {
      e.preventDefault(); var roleId = $('ra-role').value; if (!roleId) { $('ra-merr').textContent = 'Pick a role.'; return; }
      var save = $('ra-msave'); save.disabled = true; save.textContent = 'Assigning…';
      tunnel('/v1/user-roles', { method: 'POST', body: { userId: user.userId, roleId: roleId } }).then(function (res) {
        if (res.status >= 400) { save.disabled = false; save.textContent = 'Assign'; $('ra-merr').textContent = (res.json && res.json.error && res.json.error.message) || ('Failed (' + res.status + ')'); return; }
        close(); toast('Role assigned ✓', 'good'); loadView();
      }).catch(function () { save.disabled = false; save.textContent = 'Assign'; $('ra-merr').textContent = 'Could not reach the secure channel.'; });
    };
  }
  /* assign a permission to a role (admin-gated — the RBAC operation that had no screen) */
  function openAssignPerm(role) {
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:250;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px';
    ov.innerHTML = '<form id="ra-cform" style="width:100%;max-width:440px;background:var(--surface);border:1px solid var(--cbord);backdrop-filter:var(--cblur);border-radius:22px;box-shadow:var(--rai);padding:24px 26px">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px"><div style="font-weight:800;font-size:17px;flex:1">Assign permission</div><button type="button" id="ra-mclose" style="border:none;background:var(--well);box-shadow:var(--ins-sm);color:var(--t2);width:32px;height:32px;border-radius:10px;cursor:pointer;font-size:17px">&times;</button></div>' +
      '<div style="font-size:12.5px;color:var(--t3);margin-bottom:16px">Role: ' + (role.roleName || role.roleCode || 'role') + '</div>' +
      '<label style="display:block;font-size:12px;font-weight:700;color:var(--t2);margin-bottom:6px">Permission <span style="color:#C0492E">*</span></label>' +
      '<select id="ra-perm" style="' + fStyle() + '"><option value="">Loading…</option></select>' +
      '<div id="ra-merr" style="min-height:16px;font-size:12.5px;color:#C0492E;font-weight:600;margin:8px 0 10px"></div>' +
      '<button type="submit" id="ra-msave" style="width:100%;padding:13px;border:none;border-radius:14px;background:var(--accent);color:#fff;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:var(--rai-sm)">Assign</button></form>';
    document.body.appendChild(ov); setTheme();
    function close() { if (ov.parentNode) ov.remove(); }
    $('ra-mclose').onclick = close; ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    fetchAllPages('/v1/permissions', function (perms) {
      var sel = $('ra-perm'); if (!sel) return;
      sel.innerHTML = '<option value="">Select…</option>' + perms.map(function (p) { var v = p.permissionId != null ? p.permissionId : guessId(p); var l = p.permissionCode || p.permissionName || (v ? String(v).slice(0, 8) : ''); return v ? '<option value="' + v + '">' + l + '</option>' : ''; }).join('');
    });
    $('ra-cform').onsubmit = function (e) {
      e.preventDefault(); var pid = $('ra-perm').value; if (!pid) { $('ra-merr').textContent = 'Pick a permission.'; return; }
      var rid = role.roleId != null ? role.roleId : guessId(role);
      var save = $('ra-msave'); save.disabled = true; save.textContent = 'Assigning…';
      tunnel('/v1/role-permissions', { method: 'POST', body: { roleId: rid, permissionId: pid } }).then(function (res) {
        if (res.status >= 400) { save.disabled = false; save.textContent = 'Assign'; $('ra-merr').textContent = (res.json && res.json.error && res.json.error.message) || ('Failed (' + res.status + ')'); return; }
        close(); toast('Permission assigned ✓', 'good');
      }).catch(function () { save.disabled = false; save.textContent = 'Assign'; $('ra-merr').textContent = 'Could not reach the secure channel.'; });
    };
  }
