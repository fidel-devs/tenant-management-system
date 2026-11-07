const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
let currentUser = null;
let authMode = 'login';
let dashboardPanel = 'overview';
let toastTimer;

const money = n => 'KSh ' + Number(n || 0).toLocaleString('en-KE', {maximumFractionDigits:2});
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dateText = d => d ? new Date(d).toLocaleDateString('en-KE',{day:'numeric',month:'short',year:'numeric'}) : '—';
const monthNow = () => new Date().toISOString().slice(0,7);
const placeholderImages = [
 'https://images.unsplash.com/photo-1600210492486-724fe5c67fb0?auto=format&fit=crop&w=900&q=80',
 'https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?auto=format&fit=crop&w=900&q=80',
 'https://images.unsplash.com/photo-1600566753086-00f18fb6b3ea?auto=format&fit=crop&w=900&q=80',
 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=900&q=80',
 'https://images.unsplash.com/photo-1600047509807-ba8f99d2cdde?auto=format&fit=crop&w=900&q=80',
 'https://images.unsplash.com/photo-1600607687920-4e2a09cf159d?auto=format&fit=crop&w=900&q=80'
];

async function api(url, options={}) {
  const response = await fetch(url, {credentials:'same-origin', headers:{'Content-Type':'application/json', ...(options.headers||{})}, ...options});
  const data = await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

function showToast(message) {
  const t=$('#toast'); t.textContent=message; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('show'),3500);
}

function showAlert(message, target='#authError') { const el=$(target); if(!el)return; el.textContent=message; el.classList.remove('hidden'); }
function hideAlert(target='#authError') { const el=$(target); if(el)el.classList.add('hidden'); }
function setView(view) {
  $('#homeView').classList.toggle('hidden',view!=='home');
  $('#authView').classList.toggle('hidden',view!=='auth');
  $('#dashboardView').classList.toggle('hidden',view!=='dashboard');
  window.scrollTo({top:0,behavior:'smooth'});
  if(view==='home') loadListings();
}

function setAuthMode(mode) {
  authMode=mode;
  const registering=mode==='register';
  $('#registerFields').classList.toggle('hidden',!registering);
  $('#roleField').classList.toggle('hidden',!registering);
  $('#authEyebrow').textContent=registering?'YOUR NEXT CHAPTER STARTS HERE':'WELCOME BACK';
  $('#authTitle').textContent=registering?'Create your account.':'Welcome back.';
  $('#authSubtitle').textContent=registering?'Choose how you want to use RentHome.':'Sign in to continue to your account.';
  $('#authSubmit').innerHTML=registering?'Create account <span>→</span>':'Log in <span>→</span>';
  $('#authSwitch').innerHTML=registering?'Already have an account? <button type="button" id="switchAuth">Log in</button>':'New to RentHome? <button type="button" id="switchAuth">Create an account</button>';
  $('#switchAuth').onclick=()=>setAuthMode(registering?'login':'register');
  $('#authForm').elements.password.autocomplete=registering?'new-password':'current-password';
  hideAlert();
}

function openAuth(mode='login') { setAuthMode(mode); setView('auth'); }
async function loadListings() {
  const grid=$('#listingGrid'); if(!grid)return;
  try {
    const params=new URLSearchParams();
    if($('#searchQuery').value.trim())params.set('q',$('#searchQuery').value.trim());
    if($('#searchCounty').value)params.set('county',$('#searchCounty').value);
    if($('#searchMax').value)params.set('maxRent',$('#searchMax').value);
    const data=await api('/api/properties?'+params.toString());
    $('#listingCount').textContent=`${data.properties.length} home${data.properties.length===1?'':'s'} available`;
    if(!data.properties.length){grid.innerHTML='<div class="empty-state">No homes match those filters yet. Try a different location or budget.</div>';return;}
    grid.innerHTML=data.properties.map((p,i)=>`<article class="house-card">

     <div class="house-photo" style="background-image:url('${esc(p.image_url||placeholderImages[i%placeholderImages.length])}')">
      <span class="house-badge">AVAILABLE NOW</span>
      <button class="heart-btn" aria-label="View house" data-detail="${p.id}">♡</button>
     </div>
      
     <div class="house-info"><div class="house-location">⌖ ${esc(p.town)}, ${esc(p.county)}</div>
      <h3>${esc(p.title)}</h3>
     <div class="house-features"><span>▦ ${p.house_type ? esc(p.house_type) : p.bedrooms+' bedroom'+(p.bedrooms===1?'':'s')}</span>
      <span>♧ ${p.bathrooms} bathroom${p.bathrooms===1?'':'s'}</span></div>
     <div class="house-bottom">
     <div class="price">${money(p.monthly_rent)} <small>/ month</small></div>
     <button class="details-link" data-detail="${p.id}">View details →</button>
     </div>
     </div>

    </article>`).join('');
    $$('[data-detail]').forEach(b=>b.onclick=()=>showPropertyDetail(data.properties.find(p=>p.id===Number(b.dataset.detail))));
  } catch(e){grid.innerHTML='<div class="empty-state">Unable to load homes right now. Check that the server and database are running.</div>';$('#listingCount').textContent='Listings unavailable';}
}
function showPropertyDetail(p) {
  if(!p)return;
  $('#modalContent').innerHTML=`<div class="eyebrow muted">PROPERTY DETAILS</div><div class="house-detail-photo" style="background-image:url('${esc(p.image_url||placeholderImages[0])}')"></div><h2>${esc(p.title)}</h2><div class="detail-price">${money(p.monthly_rent)} <small>/ month</small></div><p>⌖ ${esc(p.address||p.town)}, ${esc(p.county)}</p><p>${esc(p.description||'Contact the landlord for more details and to arrange a viewing.')}</p><p>▦ ${p.house_type ? esc(p.house_type) : p.bedrooms+' bedroom(s)'} &nbsp; ♧ ${p.bathrooms} bathroom(s)</p><div class="panel" style="margin-top:18px"><strong>${esc(p.landlord_name)}</strong><p>Contact the landlord to arrange a viewing. Never send a deposit before confirming the property and rental terms.</p><a class="btn btn-primary full-btn" href="tel:${esc(p.landlord_phone)}">Call landlord · ${esc(p.landlord_phone)}</a></div>`;
  $('#modalBackdrop').classList.remove('hidden');
}
function closeModal(){ $('#modalBackdrop').classList.add('hidden'); }
async function boot() {
  $('#year').textContent=new Date().getFullYear();
  $('#loginOpen').onclick=()=>openAuth('login');
  $('#registerOpen').onclick=()=>openAuth('register');
  $('#backHome').onclick=()=>setView('home');
  $('#modalClose').onclick=closeModal;
  $('#modalBackdrop').addEventListener('click',e=>{if(e.target.id==='modalBackdrop')closeModal();});
  $('#searchForm').addEventListener('submit',e=>{e.preventDefault();loadListings();});
  $('#authForm').addEventListener('submit',submitAuth);
  $('#logoutBtn').onclick=logout; $('#dashLogout').onclick=logout;
  $$('.side-link[data-panel]').forEach(b=>b.onclick=()=>{dashboardPanel=b.dataset.panel;renderPanel();});
  $$('[data-view="home"]').forEach(b=>b.onclick=e=>{e.preventDefault();setView('home');});
  $('#menuToggle').onclick=()=>document.querySelector('.main-nav').classList.toggle('mobile-open');
  try {const d=await api('/api/auth/me');if(d.user){currentUser=d.user;showDashboard();return;}}catch(e){}
  setView('home'); loadListings();
}
async function submitAuth(e) {
  e.preventDefault(); hideAlert();
  const form=e.currentTarget; const fd=new FormData(form); const body=Object.fromEntries(fd.entries());
  try {
    const data=await api(authMode==='register'?'/api/auth/register':'/api/auth/login',{method:'POST',body:JSON.stringify(body)});
    currentUser=data.user; form.reset(); showDashboard(); showToast(`Welcome${currentUser.full_name?' '+currentUser.full_name.split(' ')[0]:''}!`);
  } catch(err){showAlert(err.message);}
}
async function logout() {
  try{await api('/api/auth/logout',{method:'POST',body:'{}'});}catch(e){}
  currentUser=null;dashboardPanel='overview';setView('home');showToast('You have logged out.');
}
function showDashboard() {
  setView('dashboard');
  $('#profileName').textContent=currentUser.full_name;
  $('#profileRole').textContent=currentUser.role;
  $('#profileAvatar').textContent=(currentUser.full_name||'R').charAt(0).toUpperCase();
  const landlord=currentUser.role==='landlord';
  $('#propertiesNav').classList.toggle('hidden',!landlord);
  $('#tenantsNav').classList.toggle('hidden',!landlord);
  $('#maintenanceNav').classList.toggle('hidden',landlord);
  dashboardPanel='overview';
  $$('.side-link[data-panel]').forEach(b=>b.classList.toggle('active',b.dataset.panel===dashboardPanel));
  renderPanel();
}
function statCard(label,value,note,icon){return `<article class="stat-card"><div class="stat-top"><span>${label}</span><span class="stat-icon">${icon}</span></div><div class="stat-value">${value}</div><div class="stat-note">${note}</div></article>`;}
function panelHeading(title,subtitle='',action=''){return `<div class="panel-heading"><div><h2>${title}</h2>${subtitle?`<p>${subtitle}</p>`:''}</div>${action}</div>`;}
async function renderPanel() {
  if(!currentUser)return;
  $$('.side-link[data-panel]').forEach(b=>b.classList.toggle('active',b.dataset.panel===dashboardPanel));
  const host=$('#dashboardContent');host.innerHTML='<div class="panel"><div class="empty-state">Loading your account…</div></div>';
  try {
    if(currentUser.role==='landlord') await renderLandlord(host);
    else await renderTenant(host);
  }catch(e){host.innerHTML=`<div class="panel"><div class="empty-state">${esc(e.message)}</div></div>`;}
}
async function renderLandlord(host) {
  if(dashboardPanel==='overview'){
    const d=await api('/api/landlord/summary');
    host.innerHTML=`<div class="stat-grid">${statCard('Total properties',d.counts.total,'Properties on your account','⌂')}${statCard('Available houses',d.counts.available,'Ready to be rented','⌁')}${statCard('Occupied houses',d.counts.occupied,'Currently marked occupied','♙')}${statCard('Collected this month',money(d.collected),'Confirmed paid records','↗')}</div>
      <div class="panel-grid"><section class="panel">${panelHeading('Your properties','A quick look at your rental portfolio','<button class="text-btn" id="addPropertyTop">+ Add property</button>')}
      ${d.properties.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>PROPERTY</th><th>MONTHLY RENT</th><th>STATUS</th></tr></thead><tbody>${d.properties.map(p=>`<tr><td><div class="property-mini"><div class="property-mini-img" style="background-image:url('${placeholderImages[p.id%placeholderImages.length]}')"></div><span><strong>${esc(p.title)}</strong><small>${esc(p.town)}</small></span></div></td><td>${money(p.monthly_rent)}</td><td><span class="status-pill ${p.status==='available'?'':'pending'}">${esc(p.status)}</span></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty-table">No properties yet. Add your first house to get started.</div>'}</section>
      <section class="panel">${panelHeading('Quick actions','Keep your property records up to date')}<div class="quick-actions"><button class="quick-action" id="addPropertyQuick"><span>⌂</span><strong>Add a property</strong><small>Create a new house listing</small></button><button class="quick-action" id="addTenantQuick"><span>♙</span><strong>Add a tenant</strong><small>Link a tenant to a house</small></button><button class="quick-action" id="recordPaymentQuick"><span>↗</span><strong>Record rent</strong><small>Save a manual payment</small></button><button class="quick-action" id="viewTenantsQuick"><span>☷</span><strong>View tenants</strong><small>Review active tenancies</small></button></div></section></div>
      <section class="panel">${panelHeading('Recent rent payments','Latest confirmed payment records')}<div id="recentPayments">${d.payments.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>TENANT</th><th>PERIOD</th><th>METHOD</th><th>AMOUNT</th></tr></thead><tbody>${d.payments.map(p=>`<tr><td><strong>${esc(p.tenant_name)}</strong>${p.house_number?'<br><small>House '+esc(p.house_number)+'</small>':''}</td><td>${esc(p.period_month)}</td><td>${esc(p.method)}</td><td>${money(p.amount)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty-table">Your rent payments will appear here.</div>'}</div></section>`;
    $('#addPropertyTop').onclick=showAddProperty;$('#addPropertyQuick').onclick=showAddProperty;
    $('#addTenantQuick').onclick=()=>{dashboardPanel='tenants';renderPanel();setTimeout(showAddTenancy,100);};
    $('#recordPaymentQuick').onclick=()=>{dashboardPanel='payments';renderPanel();};
    $('#viewTenantsQuick').onclick=()=>{dashboardPanel='tenants';renderPanel();};
  } else if(dashboardPanel==='properties') {
    const d=await api('/api/landlord/summary');
    host.innerHTML=`<div class="dash-action"><div><h2>My properties</h2><p>Manage your listings and property availability.</p></div><button class="btn btn-primary" id="addPropertyTop">+ Add property</button></div><section class="panel">${d.properties.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>PROPERTY</th><th>LOCATION</th><th>RENT</th><th>STATUS</th></tr></thead><tbody>${d.properties.map(p=>`<tr><td><strong>${esc(p.title)}</strong></td><td>${esc(p.town)}</td><td>${money(p.monthly_rent)}</td><td><span class="status-pill ${p.status==='available'?'':'pending'}">${esc(p.status)}</span></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty-table">No properties yet.</div>'}</section>`;
    $('#addPropertyTop').onclick=showAddProperty;
  } else if(dashboardPanel==='tenants') {
    const d=await api('/api/landlord/tenants');
    host.innerHTML=`<div class="dash-action"><div><h2>Tenants</h2><p>Link a registered tenant to one of your available houses.</p></div><button class="btn btn-primary" id="addTenancyBtn">+ Add tenancy</button></div><section class="panel">${d.tenants.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>TENANT</th><th>HOUSE NO.</th><th>PROPERTY</th><th>START DATE</th><th>MONTHLY RENT</th><th>TOTAL PAID</th><th>ACTION</th></tr></thead><tbody>${d.tenants.map(t=>`<tr><td><strong>${esc(t.full_name)}</strong><br><small>${esc(t.email)}</small></td><td><strong>${esc(t.house_number||'—')}</strong></td><td>${esc(t.property_title)}<br><small>${esc(t.town)}</small></td><td>${dateText(t.start_date)}</td><td>${money(t.monthly_rent)}</td><td>${money(t.total_paid)}</td><td>${t.status==='active'?`<button class="btn btn-danger btn-sm" data-end="${t.tenancy_id}">End tenancy</button>`:'<span class="status-pill pending">ended</span>'}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty-table">No tenancies yet. Create a tenant account first, then link it to a property.</div>'}</section>`;
    $('#addTenancyBtn').onclick=showAddTenancy;
    $$('[data-end]').forEach(b=>b.onclick=()=>endTenancy(b.dataset.end));
  } else if(dashboardPanel==='payments') {
    const d=await api('/api/landlord/tenants');
    const active=d.tenants.filter(t=>t.status==='active');
    host.innerHTML=`<div class="dash-action"><div><h2>Rent & payments</h2><p>Record rent paid in cash, bank, M-Pesa or another method.</p></div></div><section class="panel"><h3 class="subhead">Record a payment</h3><p class="subcopy">Only record a manual payment after you have received or verified it.</p><form id="manualPaymentForm" class="dash-form">
      <label class="wide">Tenant and property<select name="tenancy_id" required>${active.map(t=>`<option value="${t.tenancy_id}">House ${esc(t.house_number||'—')} · ${esc(t.full_name)} · ${esc(t.property_title)}</option>`).join('')}</select></label>
      <label>Amount (KSh)<input name="amount" type="number" min="1" step="1" required placeholder="e.g. 8500"></label>
      <label>Rent month<input name="period_month" type="month" value="${monthNow()}" required></label>
      <label>Payment method<select name="method"><option value="cash">Cash</option><option value="bank">Bank transfer</option><option value="mpesa">M-Pesa (manual verified record)</option><option value="other">Other</option></select></label>
      <label>Reference / receipt number<input name="reference" placeholder="Optional reference"></label>
      <label class="wide">Note<textarea name="note" rows="2" placeholder="Optional note"></textarea></label>
      <div class="form-actions"><button class="btn btn-primary" type="submit" ${active.length?'':'disabled'}>Save payment</button></div></form>${active.length?'':'<p class="subcopy">Create an active tenancy before recording rent.</p>'}</section>
      <section class="panel">${panelHeading('Payment records','Recent payments appear on the overview after saving.') }<p class="subcopy">This starter version lists recent payments on the Overview screen. Pending M-Pesa requests are not treated as paid.</p><button class="btn btn-quiet" id="backOverview">View recent payments</button></section>`;
    $('#manualPaymentForm').onsubmit=submitManualPayment;$('#backOverview').onclick=()=>{dashboardPanel='overview';renderPanel();};
  }
}
async function renderTenant(host) {
  if(dashboardPanel==='maintenance'){
    const d=await api('/api/tenant/overview');
    host.innerHTML=`<div class="dash-action"><div><h2>Maintenance requests</h2><p>Tell your landlord about a repair or issue.</p></div></div><section class="panel"><h3 class="subhead">Create a request</h3><form id="maintenanceForm" class="dash-form"><label class="wide">Your tenancy<select name="tenancy_id" required>${d.tenancies.map(t=>`<option value="${t.tenancy_id}">${esc(t.title)} · ${esc(t.town)}</option>`).join('')}</select></label><label class="wide">Request title<input name="title" required placeholder="e.g. Kitchen tap is leaking"></label><label class="wide">Details<textarea name="description" rows="3" placeholder="Describe the issue and when it started"></textarea></label><div class="form-actions"><button class="btn btn-primary" type="submit" ${d.tenancies.length?'':'disabled'}>Send request</button></div></form></section><section class="panel">${panelHeading('Your requests')}${d.requests.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>REQUEST</th><th>DATE</th><th>STATUS</th></tr></thead><tbody>${d.requests.map(r=>`<tr><td><strong>${esc(r.title)}</strong></td><td>${dateText(r.created_at)}</td><td><span class="status-pill ${r.status==='completed'?'':'pending'}">${esc(r.status.replace('_',' '))}</span></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty-table">No requests yet.</div>'}</section>`;
    $('#maintenanceForm').onsubmit=submitMaintenance;return;
  }
  const d=await api('/api/tenant/overview');
  const active=d.tenancies[0];
  if(dashboardPanel==='payments'){
    host.innerHTML=`<div class="dash-action"><div><h2>Rent & payments</h2><p>View payment records linked to your tenancy.</p></div></div><section class="panel">${d.payments.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>MONTH</th><th>DATE</th><th>METHOD</th><th>REFERENCE</th><th>STATUS</th><th>AMOUNT</th></tr></thead><tbody>${d.payments.map(p=>`<tr><td>${esc(p.period_month)}</td><td>${dateText(p.created_at)}</td><td>${esc(p.method)}</td><td>${esc(p.mpesa_receipt||p.reference||'—')}</td><td><span class="status-pill ${p.status==='pending'?'pending':p.status==='failed'?'failed':''}">${esc(p.status)}</span></td><td>${money(p.amount)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty-table">No payment records yet.</div>'}</section>`;
    return;
  }
  host.innerHTML=`<div class="stat-grid">${statCard('Active tenancies',d.tenancies.length,'Your current rental agreements','⌂')}${statCard('Payments recorded',d.payments.filter(p=>p.status==='paid').length,'Confirmed records','↗')}${statCard('Maintenance requests',d.requests.length,'Requests submitted','⚒')}${statCard('Account type','Tenant','Your RentHome account','♙')}</div>
    <div class="panel-grid"><section class="panel">${panelHeading('Your home','Current tenancy details')} ${active?`<div class="property-mini" style="margin:8px 0 20px"><div class="property-mini-img" style="width:65px;height:62px;background-image:url('${placeholderImages[1]}')"></div><span><strong>${esc(active.title)}</strong><small>${esc(active.address||active.town)}, ${esc(active.county)}</small></span></div><div class="stat-grid" style="grid-template-columns:1fr 1fr"><div class="stat-card"><div class="stat-top">Monthly rent</div><div class="stat-value" style="font-size:20px">${money(active.monthly_rent)}</div></div><div class="stat-card"><div class="stat-top">Move-in date</div><div class="stat-value" style="font-size:16px">${dateText(active.start_date)}</div></div></div><p class="subcopy">Landlord: ${esc(active.landlord_name)} · ${esc(active.landlord_phone)}</p>`:'<div class="empty-table">No active tenancy is linked to your account yet. Browse houses and contact a landlord.</div>'}</section>
    <section class="panel">${panelHeading('Quick actions','What would you like to do?')}<div class="quick-actions"><button class="quick-action" id="tenantPayments"><span>↗</span><strong>View payments</strong><small>Check your rent history</small></button><button class="quick-action" id="tenantMaintenance"><span>⚒</span><strong>Request a repair</strong><small>Tell your landlord about an issue</small></button><button class="quick-action" id="tenantFindHome"><span>⌂</span><strong>Find a home</strong><small>Explore available properties</small></button><button class="quick-action" id="tenantContact"><span>☎</span><strong>Contact landlord</strong><small>Discuss your tenancy</small></button></div></section></div>
    <section class="panel">${panelHeading('Recent payments','Your latest payment records')}${d.payments.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>MONTH</th><th>METHOD</th><th>STATUS</th><th>AMOUNT</th></tr></thead><tbody>${d.payments.slice(0,6).map(p=>`<tr><td>${esc(p.period_month)}</td><td>${esc(p.method)}</td><td><span class="status-pill ${p.status==='pending'?'pending':p.status==='failed'?'failed':''}">${esc(p.status)}</span></td><td>${money(p.amount)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty-table">Payment records will appear here.</div>'}</section>`;
  $('#tenantPayments').onclick=()=>{dashboardPanel='payments';renderPanel();};
  $('#tenantMaintenance').onclick=()=>{dashboardPanel='maintenance';renderPanel();};
  $('#tenantFindHome').onclick=()=>{setView('home');};
  $('#tenantContact').onclick=()=>{if(active)window.location.href='tel:'+active.landlord_phone;else showToast('No landlord is linked to your account yet.');};
}
function showAddProperty() {
  $('#modalContent').innerHTML=`<div class="eyebrow muted">LANDLORD WORKSPACE</div><h2>Add a property</h2><p>New listings are shown publicly while their status is available. Use an image URL from a photo you have permission to use.</p><form id="propertyForm" class="modal-form"><label>Property title<input name="title" required placeholder="e.g. Sunny 2-bedroom apartment"></label><div class="dash-form"><label>County<input name="county" required placeholder="e.g. Kirinyaga"></label><label>Town / estate<input name="town" required placeholder="e.g. Kerugoya"></label><label>Monthly rent (KSh)<input name="monthly_rent" type="number" min="1" required placeholder="8500"></label><label>Type<input name="house_type" type="text" maxlength="100" placeholder="e.g. Bedsitter, Single room, 2 bedroom"></label><label>Bathrooms<input name="bathrooms" type="number" min="0" value="1"></label><label>Full address<input name="address" required placeholder="Street, estate or plot number"></label><label class="wide">Image URL<input name="image_url" type="url" placeholder="https://... (optional)"></label><label class="wide">Description<textarea name="description" rows="3" placeholder="Describe the house and amenities"></textarea></label></div><button class="btn btn-primary full-btn" type="submit">Save property</button></form>`;
  $('#modalBackdrop').classList.remove('hidden');$('#propertyForm').onsubmit=submitProperty;
}
async function submitProperty(e) {
  e.preventDefault();const body=Object.fromEntries(new FormData(e.currentTarget).entries());
  try{await api('/api/properties',{method:'POST',body:JSON.stringify(body)});closeModal();showToast('Property added successfully.');dashboardPanel='properties';renderPanel();}
  catch(err){showToast(err.message);}
}
async function showAddTenancy() {
  try {
    const d=await api('/api/landlord/summary');
    const available=d.properties.filter(p=>p.status==='available');
    $('#modalContent').innerHTML=`<div class="eyebrow muted">LANDLORD WORKSPACE</div><h2>Link a tenant to a house</h2><p>The tenant must create a RentHome account first. Use their registered email address.</p><form id="tenancyForm" class="modal-form"><label>Available property<select name="property_id" required>${available.map(p=>`<option value="${p.id}">${esc(p.title)} · ${esc(p.town)} · ${money(p.monthly_rent)}</option>`).join('')}</select></label><label>Tenant email<input type="email" name="tenant_email" required placeholder="tenant@example.com"></label><label>House number<input name="house_number" required maxlength="30" placeholder="e.g. A3 or 12"></label><label>Tenancy start date<input type="date" name="start_date" required value="${new Date().toISOString().slice(0,10)}"></label><button class="btn btn-primary full-btn" type="submit" ${available.length?'':'disabled'}>Create tenancy</button></form>${available.length?'':'<p>No available properties found. Add or free up a property first.</p>'}`;
    $('#modalBackdrop').classList.remove('hidden');$('#tenancyForm').onsubmit=submitTenancy;
  } catch(e){showToast(e.message);}
}
async function submitTenancy(e) {
  e.preventDefault();const body=Object.fromEntries(new FormData(e.currentTarget).entries());
  try{await api('/api/landlord/tenancies',{method:'POST',body:JSON.stringify(body)});closeModal();showToast('Tenancy created and house marked occupied.');dashboardPanel='tenants';renderPanel();}
  catch(err){showToast(err.message);}
}
async function submitManualPayment(e) {
  e.preventDefault();const body=Object.fromEntries(new FormData(e.currentTarget).entries());
  try{await api('/api/landlord/payments/manual',{method:'POST',body:JSON.stringify(body)});showToast('Payment record saved.');renderPanel();}
  catch(err){showToast(err.message);}
}
async function submitMaintenance(e) {
  e.preventDefault();const body=Object.fromEntries(new FormData(e.currentTarget).entries());
  try{await api('/api/tenant/maintenance',{method:'POST',body:JSON.stringify(body)});showToast('Maintenance request sent.');renderPanel();}
  catch(err){showToast(err.message);}
}
boot();

/* =========================================================
   RentHome add-ons - load this AFTER app.js. Nothing in app.js is edited.
   Adds:
   1. Property images always display when a URL is given
   2. Landlord can edit and remove properties
   3. Tenant can submit rent payments; landlord verifies or rejects them
   ========================================================= */
(function () {
  'use strict';

  /* ---------- 1. IMAGE URLS: clean them so they always display ---------- */
  function cleanUrl(u) {
    if (typeof u !== 'string') return u;
    u = u.trim();
    if (!u) return u;
    if (/^\/\//.test(u)) u = 'https:' + u;
    else if (!/^(https?:|data:|\/)/i.test(u)) u = 'https://' + u;
    return u.replace(/\s/g, '%20').replace(/'/g, '%27').replace(/"/g, '%22').replace(/\(/g, '%28').replace(/\)/g, '%29');
  }
  function normalise(v) {
    if (Array.isArray(v)) return v.map(normalise);
    if (v && typeof v === 'object') {
      for (const k in v) {
        if (k === 'image_url') v[k] = cleanUrl(v[k]);
        else if (v[k] && typeof v[k] === 'object') v[k] = normalise(v[k]);
      }
    }
    return v;
  }
  const baseApi = window.api;
  const cache = {};
  window.api = async function (url, options) {
    const get = !options || !options.method || String(options.method).toUpperCase() === 'GET';
    if (!get) { for (const k in cache) delete cache[k]; return normalise(await baseApi(url, options)); }
    const hit = cache[url];
    if (hit && Date.now() - hit.t < 4000) return hit.p;
    const p = baseApi(url, options).then(normalise);
    cache[url] = { t: Date.now(), p };
    p.catch(() => { delete cache[url]; });
    return p;
  };

    function attachPreview(form, prop) {
    const input = form.querySelector('[name="image_url"]');
    if (!input) return;
    const box = document.createElement('div');
    box.className = 'img-preview hidden';
    input.closest('label').appendChild(box);
    let timer;
    const update = () => {
      const u = cleanUrl(input.value);
      if (!u) { box.className = 'img-preview hidden'; box.innerHTML = ''; return; }
      box.className = 'img-preview';
      box.innerHTML = `<img alt="Preview" src="${esc(u)}">`;
      box.firstChild.onerror = () => { box.className = 'img-preview bad'; box.textContent = 'This image could not be loaded. Check that the link opens a picture.'; };
    };

    /* extra images: up to 8 in total */
    const MAX = 8;
    const hidden = document.createElement('input');
    hidden.type = 'hidden'; hidden.name = 'image_urls'; hidden.value = '[]';
    form.appendChild(hidden);
    const extra = document.createElement('div');
    extra.className = 'wide';
    extra.innerHTML = '<div class="subcopy" style="margin:6px 0">More photos (up to 8 in total, each with its own link)</div><div class="extra-list" style="display:grid;gap:8px"></div><button type="button" class="btn btn-quiet btn-sm extra-add" style="margin-top:8px">+ Add another image</button><div class="extra-thumbs" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px"></div>';
    input.closest('label').insertAdjacentElement('afterend', extra);
    const list = extra.querySelector('.extra-list'), addBtn = extra.querySelector('.extra-add'), thumbs = extra.querySelector('.extra-thumbs');
    const sync = () => {
      const urls = [];
      [input, ...list.querySelectorAll('input')].forEach(i => { const u = cleanUrl(i.value); if (u && !urls.includes(u)) urls.push(u); });
      const final = urls.slice(0, MAX);
      hidden.value = JSON.stringify(final);
      thumbs.innerHTML = final.map(u => `<img alt="" src="${esc(u)}" style="width:56px;height:44px;object-fit:cover;border-radius:6px">`).join('');
      addBtn.classList.toggle('hidden', list.children.length >= MAX - 1);
    };
    const addField = (value = '') => {
      if (list.children.length >= MAX - 1) return;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px';
      row.innerHTML = `<input type="text" inputmode="url" placeholder="https://... another image link" style="flex:1" value="${esc(value)}"><button type="button" class="btn btn-danger btn-sm" aria-label="Remove image">✕</button>`;
      row.querySelector('input').addEventListener('input', sync);
      row.querySelector('button').onclick = () => { row.remove(); sync(); };
      list.appendChild(row); sync();
    };
    addBtn.onclick = () => addField();
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(update, 400); sync(); });
    imagesOf(prop).filter(u => u !== cleanUrl(input.value)).forEach(addField);
    update(); sync();
  }

  /* Add-property form gets a live image preview */
  const baseAdd = window.showAddProperty;
  window.showAddProperty = function () { baseAdd(); const form = $('#propertyForm'); if (form) attachPreview(form); };

  /* ---------- 2. LANDLORD: EDIT AND REMOVE PROPERTIES ---------- */
  function showEditProperty(p) {
    $('#modalContent').innerHTML = `<div class="eyebrow muted">LANDLORD WORKSPACE</div><h2>Edit property</h2><p>Changes appear on the public listing straight away.</p>
      <form id="editPropertyForm" class="modal-form"><label>Property title<input name="title" required value="${esc(p.title)}"></label>
      <div class="dash-form"><label>County<input name="county" required value="${esc(p.county)}"></label><label>Town / estate<input name="town" required value="${esc(p.town)}"></label>
      <label>Monthly rent (KSh)<input name="monthly_rent" type="number" min="1" required value="${Number(p.monthly_rent)}"></label>
      <label>Type<input name="house_type" type="text" maxlength="100" value="${esc(p.house_type || '')}" placeholder="e.g. Bedsitter, Single room, 2 bedroom"></label>
      <label>Bathrooms<input name="bathrooms" type="number" min="0" value="${Number(p.bathrooms ?? 1)}"></label>
      <label>Full address<input name="address" value="${esc(p.address || '')}"></label>
      <label class="wide">Image URL<input name="image_url" type="url" placeholder="https://..." value="${esc(p.image_url || '')}"></label>
      <label class="wide">Description<textarea name="description" rows="3">${esc(p.description || '')}</textarea></label></div>
      <button class="btn btn-primary full-btn" type="submit">Save changes</button></form>`;
    $('#modalBackdrop').classList.remove('hidden');
    const form = $('#editPropertyForm');

    attachPreview(form, p);
    /* the address identifies the property: it is locked, and only an admin can approve a change */
    ['county', 'town', 'address'].forEach(n => { const el = form.elements[n]; if (el) { el.readOnly = true; el.style.background = '#f3f4f6'; el.title = 'Changing the address needs admin verification'; } });
    const reqBtn = document.createElement('button');
    reqBtn.type = 'button'; reqBtn.className = 'btn btn-quiet btn-sm'; reqBtn.textContent = 'Request address change';
    reqBtn.style.cssText = 'grid-column:1/-1;justify-self:start';
    reqBtn.onclick = () => window.showAddressRequest(p);
    form.elements['address'].closest('label').insertAdjacentElement('afterend', reqBtn);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(form).entries());
      try {
        await api('/api/properties/' + p.id, { method: 'PUT', body: JSON.stringify(body) });
        closeModal(); showToast('Property updated.'); renderPanel();
      } catch (err) { showToast(err.message); }
    };
  }
  async function removeProperty(p) {
    if (!confirm(`Remove "${p.title}" from your properties?\nIt will no longer be shown to tenants.`)) return;
    try {
      const r = await api('/api/properties/' + p.id, { method: 'DELETE' });
      showToast(r.archived ? 'Property removed. Its rent history has been kept.' : 'Property deleted.');
      renderPanel();
    } catch (err) { showToast(err.message); }
  }
  async function renderProps(host) {
    let list, canEdit = true;
    try { list = (await api('/api/landlord/properties')).properties; }
    catch (e) { canEdit = false; list = (await api('/api/landlord/summary')).properties; }
    const thumb = p => `<div class="property-mini-img" style="background-image:url('${esc(p.image_url || placeholderImages[p.id % placeholderImages.length])}')"></div>`;
    host.innerHTML = `<div class="dash-action"><div><h2>My properties</h2><p>Manage your listings, photos and availability.</p></div><button class="btn btn-primary" id="addPropertyTop">+ Add property</button></div>
      <section class="panel">${list.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>PROPERTY</th><th>LOCATION</th><th>RENT</th><th>STATUS</th>${canEdit ? '<th>ACTIONS</th>' : ''}</tr></thead><tbody>${list.map(p => `<tr>
        <td><div class="property-mini">${thumb(p)}<span><strong>${esc(p.title)}</strong></span></div></td><td>${esc(p.town)}</td><td>${money(p.monthly_rent)}</td>
        <td><span class="status-pill ${p.status === 'available' ? '' : 'pending'}">${esc(p.status)}</span></td>
        ${canEdit ? `<td><div class="row-actions"><button class="btn btn-quiet btn-sm" data-edit="${p.id}">Edit</button><button class="btn btn-danger btn-sm" data-remove="${p.id}">Remove</button></div></td>` : ''}</tr>`).join('')}</tbody></table></div>` : '<div class="empty-table">No properties yet.</div>'}
        ${canEdit ? '' : '<p class="subcopy" style="margin-top:14px">Edit and remove need the new server routes (server-additions.js).</p>'}</section>`;
    $('#addPropertyTop').onclick = window.showAddProperty;
    $$('[data-edit]').forEach(b => b.onclick = () => showEditProperty(list.find(p => p.id === Number(b.dataset.edit))));
    $$('[data-remove]').forEach(b => b.onclick = () => removeProperty(list.find(p => p.id === Number(b.dataset.remove))));
  }
  async function fixOverviewImages() {
    try {
      const sum = (await api('/api/landlord/summary')).properties || [];
      let full = []; try { full = (await api('/api/landlord/properties')).properties; } catch (e) {}
      const byId = Object.fromEntries(full.map(p => [p.id, p]));
      $$('#dashboardContent .property-mini-img').forEach((el, i) => {
        const p = sum[i]; const u = p && (p.image_url || (byId[p.id] || {}).image_url);
        if (u) el.style.backgroundImage = `url("${u}")`;
      });
    } catch (e) {}
  }

  /* ---------- 3a. LANDLORD: VERIFY TENANT PAYMENTS ---------- */
  async function refreshBadge() {
    if (!currentUser || currentUser.role !== 'landlord') return 0;
    try {
      const list = (await api('/api/landlord/payments')).payments;
      const n = list.filter(p => p.status === 'pending' && !p.auto).length;
      const link = $('.side-link[data-panel="payments"]');
      if (link) { const old = link.querySelector('.nav-badge'); if (old) old.remove(); if (n) link.insertAdjacentHTML('beforeend', `<b class="nav-badge">${n}</b>`); }
      return n;
    } catch (e) { return 0; }
  }
  async function decide(id, action) {
    const msg = action === 'approve' ? 'Confirm that you have received this payment?' : 'Reject this payment? The tenant will be told it was not verified.';
    if (!confirm(msg)) return;
    try {
      await api(`/api/landlord/payments/${id}/verify`, { method: 'POST', body: JSON.stringify({ action }) });
      showToast(action === 'approve' ? 'Payment verified.' : 'Payment rejected.');
      renderPanel(); refreshBadge();
    } catch (err) { showToast(err.message); }
  }
  async function injectVerifyPanel(host) {
    let html;
    try {
      const list = (await api('/api/landlord/payments')).payments;
      const pending = list.filter(p => p.status === 'pending' && !p.auto).length;
      html = `<section class="panel">${panelHeading('Verify tenant payments', pending ? `${pending} waiting for you` : 'Nothing waiting right now')}
        ${list.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>TENANT</th><th>MONTH</th><th>METHOD</th><th>REFERENCE</th><th>AMOUNT</th><th>STATUS</th><th></th></tr></thead><tbody>${list.slice(0, 25).map(p => `<tr>
          <td><strong>${esc(p.tenant_name)}</strong><br><small>House ${esc(p.house_number || '—')} · ${esc(p.property_title || '')}</small></td><td>${esc(p.period_month)}</td><td>${esc(p.method)}</td>
          <td>${esc(p.mpesa_receipt || (p.auto ? '' : p.reference) || '—')}</td><td>${money(p.amount)}</td>
          <td><span class="status-pill ${p.status === 'pending' ? 'pending' : p.status === 'failed' ? 'failed' : ''}">${esc(p.status)}</span></td>
          <td>${p.status === 'pending' && p.auto ? '<small>Awaiting M-Pesa</small>' : p.status === 'pending' ? `<div class="row-actions"><button class="btn btn-primary btn-sm" data-verify="${p.id}">Verify</button><button class="btn btn-danger btn-sm" data-reject="${p.id}">Reject</button></div>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-table">Payments your tenants submit will appear here.</div>'}</section>`;
    } catch (e) {
      html = `<section class="panel">${panelHeading('Verify tenant payments')}<div class="empty-table">Payment verification is not switched on yet (${esc(e.message)}).</div></section>`;
    }
    if (dashboardPanel !== 'payments') return;
    const head = host.querySelector('.dash-action');
    if (head) head.insertAdjacentHTML('afterend', html); else host.insertAdjacentHTML('afterbegin', html);
    $$('[data-verify]').forEach(b => b.onclick = () => decide(b.dataset.verify, 'approve'));
    $$('[data-reject]').forEach(b => b.onclick = () => decide(b.dataset.reject, 'reject'));
  }

  /* ---------- 3b. TENANT: PAY RENT ---------- */
  async function injectPayForm(host) {
    const d = await api('/api/tenant/overview');
    if (dashboardPanel !== 'payments') return;
    const t = d.tenancies || [];
    const html = `<section class="panel" id="payRentPanel"><h3 class="subhead">Pay rent</h3>
      ${t.length ? `<p class="subcopy">Pay with an M-Pesa prompt on your phone, or pay another way and enter the code so your landlord can verify it.</p>
      <form id="payRentForm" class="dash-form">
        <label class="wide">Tenancy<select name="tenancy_id" id="payTenancy" required>${t.map(x => `<option value="${x.tenancy_id}" data-rent="${Number(x.monthly_rent)}" data-name="${esc(x.landlord_name)}" data-phone="${esc(x.landlord_phone)}">${esc(x.title)} · ${esc(x.town)}</option>`).join('')}</select></label>
        <label>Payment method<select name="method" id="payMethod"><option value="stk">M-Pesa prompt on my phone</option><option value="mpesa">I already paid by M-Pesa (enter code)</option><option value="bank">Bank transfer</option><option value="cash">Cash</option></select></label>
        <label>Rent month<input name="period_month" type="month" value="${monthNow()}" required></label>
        <div class="wide pay-to" id="payTo"></div>
        <label>Amount (KSh)<input name="amount" id="payAmount" type="number" min="1" step="1" required></label>
        <label id="payPhoneLabel">M-Pesa phone number<input name="phone" id="payPhone" value="${esc((currentUser && currentUser.phone) || '')}" placeholder="0712345678" autocomplete="tel"></label>
        <label id="payRefLabel" class="hidden">M-Pesa transaction code<input name="reference" id="payRef" maxlength="30" placeholder="e.g. QGH7ABC123" autocomplete="off"></label>
        <label class="wide">Note<textarea name="note" rows="2" placeholder="Optional note to your landlord"></textarea></label>
        <div class="form-actions"><button class="btn btn-primary" type="submit" id="payBtn">Send M-Pesa prompt to my phone</button></div></form>` : '<div class="empty-table">You need an active tenancy before you can pay rent.</div>'}</section>`;
    const head = host.querySelector('.dash-action');
    if (head) head.insertAdjacentHTML('afterend', html); else host.insertAdjacentHTML('afterbegin', html);
    const form = $('#payRentForm'); if (!form) return;
    const sel = $('#payTenancy'), method = $('#payMethod'), ref = $('#payRef'), phone = $('#payPhone');
    const sync = () => {
      const o = sel.selectedOptions[0]; $('#payAmount').value = o.dataset.rent;
      const m = method.value;
      $('#payTo').innerHTML = m === 'stk' ? `A payment request will pop up on your phone. Enter your M-Pesa PIN to pay <strong>${esc(o.dataset.name)}</strong>. It is confirmed automatically.`
        : m === 'mpesa' ? `Send the money by M-Pesa to <strong>${esc(o.dataset.name)}</strong> on <strong>${esc(o.dataset.phone)}</strong>, then enter the 10-character code from the M-Pesa message. Your landlord will verify it.`
        : m === 'bank' ? `Pay <strong>${esc(o.dataset.name)}</strong> by bank transfer (ask for the account details on <strong>${esc(o.dataset.phone)}</strong>), then enter the bank reference. Your landlord will verify it.`
        : `Hand the cash to <strong>${esc(o.dataset.name)}</strong>. They will confirm it here once received.`;
      $('#payPhoneLabel').classList.toggle('hidden', m !== 'stk');
      $('#payRefLabel').classList.toggle('hidden', m === 'stk');
      $('#payRefLabel').firstChild.textContent = m === 'mpesa' ? 'M-Pesa transaction code' : m === 'bank' ? 'Bank reference' : 'Receipt number (optional)';
      ref.required = (m === 'mpesa' || m === 'bank'); phone.required = (m === 'stk');
      $('#payBtn').textContent = m === 'stk' ? 'Send M-Pesa prompt to my phone' : 'Submit payment for verification';
    };
    sel.onchange = sync; method.onchange = sync; sync();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(form).entries());
      const btn = $('#payBtn');
      if (body.method === 'stk') {
        btn.disabled = true;
        try {
          const r = await api('/api/mpesa/stkpush', { method: 'POST', body: JSON.stringify({ tenancy_id: body.tenancy_id, amount: body.amount, phone: body.phone, period_month: body.period_month }) });
          showToast(r.message || 'Check your phone for the M-Pesa prompt.'); renderPanel(); watchPendingPayment();
        } catch (err) { showToast(err.message); btn.disabled = false; }
        return;
      }
      body.reference = (body.reference || '').trim().toUpperCase();
      if (body.method === 'mpesa' && !/^[A-Z0-9]{10}$/.test(body.reference)) { showToast('The M-Pesa code is 10 letters and numbers, e.g. QGH7ABC123.'); return; }
      btn.disabled = true;
      try {
        await api('/api/tenant/payments', { method: 'POST', body: JSON.stringify(body) });
        showToast('Payment submitted. Your landlord will verify it.'); renderPanel();
      } catch (err) { showToast(err.message); btn.disabled = false; }
    };
  }

  async function watchPendingPayment() {
    try {
      const pendingCount = async () => {
        const d = await api('/api/tenant/overview');
        return (d.payments || []).filter(p => p.status === 'pending').length;
      };
      const before = await pendingCount();
      if (!before) return;
      let tries = 0;
      const timer = setInterval(async () => {
        tries++;
        try {
          const now = await pendingCount();
          if (now < before || tries >= 36) {
            clearInterval(timer);
            if (now < before) { renderPanel(); showToast('Payment status updated.'); }
          }
        } catch (e) { clearInterval(timer); }
      }, 5000);
    } catch (e) {}
  }

      async function injectRentStatus(host) {
    try {
      const d = await api('/api/tenant/rent-status');
      const t = d.tenancies && d.tenancies[0];
      const banner = host.querySelector('.pay-banner');
      if (!t || !banner) return;
      const label = { paid: 'Paid up', due_soon: 'Due soon', late: 'Late', upcoming: 'Upcoming' }[t.status] || t.status;
      const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
      const line = t.status === 'late'
        ? `${plural(t.days_late, 'day')} late · ${plural(t.months_overdue, 'month')} unpaid`
        : t.status === 'paid'
          ? (t.credit > 0 ? `Credit ${money(t.credit)} · next rent due ${esc(t.due_date)}` : `Next rent due ${esc(t.due_date)}`)
          : `Due by ${esc(t.due_date)}`;
      banner.insertAdjacentHTML('afterend',
        `<section class="rent-status-card"><div class="rs-row"><strong>Rent status</strong><span class="rs-badge rs-${t.status}">${label}</span></div>` +
        `<div class="rs-row"><span>Balance owed</span><strong>${money(t.balance)}</strong></div>` +
        `<small>${line}</small>` +
        (t.pending ? '<small>A payment is waiting for confirmation.</small>' : '') +
        `</section>`);
    } catch (e) {}
  }

  async function injectPayBanner(host) {
    const d = await api('/api/tenant/overview');
    if (dashboardPanel !== 'overview') return;
    const a = d.tenancies && d.tenancies[0];
    if (!a) return;
    const here = d.payments.filter(p => p.period_month === monthNow());
    const paid = here.some(p => p.status === 'paid'), pend = here.some(p => p.status === 'pending');
    const img = host.querySelector('.property-mini-img'); if (img && a.image_url) img.style.backgroundImage = `url("${a.image_url}")`;
    host.insertAdjacentHTML('afterbegin', `<section class="pay-banner ${paid ? 'done' : ''}"><div><strong>${paid ? '✓ This month’s rent is paid' : pend ? 'Payment waiting for your landlord to verify' : 'Rent due this month'}</strong><small>${money(a.monthly_rent)} · ${esc(a.title)}</small></div>${paid ? '' : '<button class="btn btn-primary" id="payRentBtn">Pay rent →</button>'}</section>`);
    const b = $('#payRentBtn'); if (b) b.onclick = () => { dashboardPanel = 'payments'; renderPanel(); };
    injectRentStatus(host);
  }



    /* ---------- MULTIPLE IMAGES ---------- */
  function imagesOf(p) {
    if (!p) return [];
    let a = p.image_urls;
    if (typeof a === 'string') { try { a = JSON.parse(a); } catch (e) { a = []; } }
    a = Array.isArray(a) ? a.slice() : [];
    if (p.image_url) a.unshift(p.image_url);
    const out = [];
    a.forEach(u => { u = cleanUrl(u); if (u && !out.includes(u)) out.push(u); });
    return out.slice(0, 8);
  }
  const baseDetail = window.showPropertyDetail;
  window.showPropertyDetail = function (p) {
    baseDetail(p);
    if (!p) return;
    const imgs = imagesOf(p);
    const main = $('#modalContent .house-detail-photo');
    if (!main || !imgs.length) return;
    const gal = document.createElement('div');
    gal.className = 'detail-gallery';
    gal.innerHTML = imgs.map((u, i) => `<img src="${esc(u)}" alt="Photo ${i + 1}" data-i="${i}" loading="lazy">`).join('');
    gal.querySelectorAll('img').forEach(im => {
      im.onerror = () => im.remove();
      im.onclick = () => openLightbox(imgs, Number(im.dataset.i));
    });
    main.replaceWith(gal);
  };

  function openLightbox(imgs, start) {
    let i = start;
    const box = document.createElement('div');
    box.className = 'lightbox';
    box.innerHTML = '<button type="button" class="lb-close" aria-label="Close">×</button><button type="button" class="lb-prev" aria-label="Previous">‹</button><img alt=""><button type="button" class="lb-next" aria-label="Next">›</button><div class="lb-count"></div>';
    const img = box.querySelector('img'), count = box.querySelector('.lb-count');
    const show = n => { i = (n + imgs.length) % imgs.length; img.src = imgs[i]; count.textContent = (i + 1) + ' / ' + imgs.length; };
    const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') show(i + 1);
      else if (e.key === 'ArrowLeft') show(i - 1);
    };
    box.querySelector('.lb-close').onclick = close;
    box.querySelector('.lb-prev').onclick = () => show(i - 1);
    box.querySelector('.lb-next').onclick = () => show(i + 1);
    box.addEventListener('click', e => { if (e.target === box) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(box);
    show(i);
  }

  /* ---------- WIRING: wrap the existing functions, never replace their logic ---------- */
  const baseLandlord = window.renderLandlord;
  window.renderLandlord = async function (host) {
    if (dashboardPanel === 'properties') return renderProps(host);
    await baseLandlord(host);
    if (dashboardPanel === 'overview') fixOverviewImages();
    if (dashboardPanel === 'payments') await injectVerifyPanel(host);
  };
  const baseTenant = window.renderTenant;
  window.renderTenant = async function (host) {
    await baseTenant(host);
    if (dashboardPanel === 'payments') await injectPayForm(host);
    else if (dashboardPanel === 'overview') await injectPayBanner(host);
  };
  const baseShow = window.showDashboard;
  window.showDashboard = function () { baseShow(); refreshBadge(); };
})();

function propertyImages(p) {
  let list = p.image_urls;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch (e) { list = []; } }
  if (!Array.isArray(list)) list = [];
  if (!list.length && p.image_url) list = [p.image_url];
  return list.slice(0, 8);
}
function imgEsc(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }
function galleryHTML(p) {
  const imgs = propertyImages(p);
  if (!imgs.length) return '';
  return `<div class="gallery">
    <img class="gallery-main" src="${imgEsc(imgs[0])}" alt="${imgEsc(p.title || 'House')}" onerror="this.style.display='none'">
    ${imgs.length > 1 ? `<div class="gallery-thumbs">${imgs.map((u, i) =>
      `<img src="${imgEsc(u)}" class="${i === 0 ? 'active' : ''}" alt="Photo ${i + 1}" onclick="swapGallery(this)" onerror="this.remove()">`).join('')}</div>` : ''}
  </div>`;
}
function swapGallery(thumb) {
  const g = thumb.closest('.gallery');
  const main = g.querySelector('.gallery-main');
  main.style.display = '';
  main.src = thumb.src;
  g.querySelectorAll('.gallery-thumbs img').forEach(i => i.classList.remove('active'));
  thumb.classList.add('active');
}

/* Landlord M-Pesa settings (shown at the bottom of Rent & payments) */
(function () {
  'use strict';
  const prevLandlord = window.renderLandlord;
  window.renderLandlord = async function (host) {
    await prevLandlord(host);
    if (dashboardPanel === 'payments') await injectMpesaSettings(host);
  };
  async function injectMpesaSettings(host) {
    let s = { configured: false, txn_type: 'paybill', shortcode: '', till_number: '', env: 'sandbox' };
    try { s = await api('/api/landlord/mpesa'); } catch (e) {}
    if (dashboardPanel !== 'payments') return;
    const keep = s.configured ? 'Leave blank to keep the saved one' : '';
    host.insertAdjacentHTML('beforeend', `<section class="panel"><h3 class="subhead">M-Pesa settings: receive rent directly</h3>
      <p class="subcopy">${s.configured ? 'M-Pesa prompts are ON. Tenants pay straight into your account.' : 'Add your own M-Pesa details so tenants can pay you with a prompt on their phone.'} Your keys are saved encrypted and are never shown again.</p>
      <form id="mpesaForm" class="dash-form">
        <label>Account type<select name="txn_type"><option value="paybill" ${s.txn_type === 'paybill' ? 'selected' : ''}>Paybill</option><option value="till" ${s.txn_type === 'till' ? 'selected' : ''}>Buy Goods till</option></select></label>
        <label>Mode<select name="env"><option value="sandbox" ${s.env === 'sandbox' ? 'selected' : ''}>Testing (sandbox)</option><option value="production" ${s.env === 'production' ? 'selected' : ''}>Live</option></select></label>
        <label>Shortcode (paybill number, or store number for a till)<input name="shortcode" required inputmode="numeric" value="${esc(s.shortcode)}"></label>
        <label>Till number (only for Buy Goods)<input name="till_number" inputmode="numeric" value="${esc(s.till_number || '')}"></label>
        <label class="wide">Passkey<input name="passkey" type="password" autocomplete="off" placeholder="${keep}"></label>
        <label>Consumer key<input name="consumer_key" type="password" autocomplete="off" placeholder="${keep}"></label>
        <label>Consumer secret<input name="consumer_secret" type="password" autocomplete="off" placeholder="${keep}"></label>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save M-Pesa settings</button></div></form></section>`);
    $('#mpesaForm').onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.currentTarget).entries());
      try {
        await api('/api/landlord/mpesa', { method: 'PUT', body: JSON.stringify(body) });
        showToast('M-Pesa settings saved.'); renderPanel();
      } catch (err) { showToast(err.message); }
    };
  }
})();

/* Landlord plan: free trial of the management tools, the plan box, and the pay window.
   Added last, so it is the outermost wrapper: it can show the "trial ended" screen
   instead of the Tenants and Rent & payments pages. */
(function () {
  'use strict';
  const prev = window.renderLandlord;
  window.renderLandlord = async function (host) {
    if (dashboardPanel === 'tenants' || dashboardPanel === 'payments') {
      let s = null;
      try { s = await api('/api/landlord/subscription'); } catch (e) {}
    if (s && !s.manage) return showLocked(host, s);
    }
    await prev(host);
    if (dashboardPanel === 'properties') await injectPlan(host);
  };
  function showLocked(host, s) {
    host.innerHTML = `<div class="panel" style="text-align:center;padding:40px 20px"><h2>Your free trial has ended</h2>
      <p class="subcopy">Managing tenants, recording and verifying rent, and collecting rent by M-Pesa need the monthly plan. Your houses are still listed.</p>
      <button class="btn btn-primary" id="lockedUpgrade">Upgrade for ${money(s.price)} per 30 days</button></div>`;
    $('#lockedUpgrade').onclick = () => showUpgrade(s);
  }
  async function injectPlan(host) {
    let s;
    try { s = await api('/api/landlord/subscription'); } catch (e) { return; }
    if (dashboardPanel !== 'properties') return;
    const status = s.active ? `Monthly plan active until ${dateText(s.paid_until)}` : `Free plan: ${s.houses} of ${s.free_limit} houses used`;
    const note = s.active ? 'You can add as many houses as you need.'
      : (s.trial_pending ? `Your free ${s.trial_months}-month trial of the management tools starts when you list your first house. `
      : s.trial_active ? `Free trial of the management tools until ${dateText(s.trial_ends)}. `
      : 'Your free trial has ended. ') + `Upgrade for ${money(s.price)} per 30 days to add more houses${s.trial_active || s.trial_pending ? ' and keep managing tenants after the trial' : ' and manage your tenants'}.`;
    const html = `<section class="panel" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><div><strong>${status}</strong><br><small>${note}</small></div><button class="btn btn-primary" id="upgradeBtn">${s.active ? 'Renew plan' : 'Upgrade'}</button></section>`;
    const head = host.querySelector('.dash-action');
    if (head) head.insertAdjacentHTML('afterend', html); else host.insertAdjacentHTML('afterbegin', html);
    $('#upgradeBtn').onclick = () => showUpgrade(s);
  }

    function showUpgrade(s) {
    const daysLeft = d => d ? Math.max(0, Math.ceil((new Date(d) - new Date()) / 86400000)) : null;
    let state, label, until;
    if (s.active) { state = 'paid'; label = 'Active'; until = s.paid_until; }
    else if (s.trial_active) { state = 'trial'; label = 'Free trial'; until = s.trial_ends; }
    else if (s.trial_pending) { state = 'free'; label = 'Free plan'; until = null; }
    else { state = 'expired'; label = 'Trial ended'; until = null; }
    const left = daysLeft(until);
    const pct = s.active ? 100 : Math.min(100, (s.houses / (s.free_limit || 1)) * 100);
    $('#modalContent').innerHTML = `<div class="plan-card">
      <div class="plan-head"><span class="plan-badge ${state}">${label}</span>
        <h2>My subscription</h2>
        <p>${money(s.price)} for 30 days. Renew any time.</p>
      </div>

      <div class="plan-body">
        <div class="plan-row"><span>Plan</span><span>${s.active ? 'Monthly plan' : 'Free plan'}</span></div>
        <div class="plan-row"><span>${s.active ? 'Paid until' : 'Trial ends'}</span><span>${until ? dateText(until) + ' (' + left + ' days left)' : (s.trial_pending ? 'Starts at your first listing' : '—')}</span></div>
        <div class="plan-row"><span>Houses listed</span><span>${s.houses}${s.active ? ' (no limit)' : ' / ' + s.free_limit}</span></div>
        <div class="plan-bar"><div style="width:${pct}%"></div></div>
        <form id="upgradeForm" class="modal-form" style="margin-top:18px">
        <label>M-Pesa phone number<input name="phone" required value="${esc((currentUser && currentUser.phone) || '')}" placeholder="0712345678" autocomplete="tel"></label>
        <button class="btn btn-primary full-btn" type="submit">${s.active ? 'Renew for ' : 'Pay '}${money(s.price)}</button>
      </form>
      </div></div>`;
    $('#modalBackdrop').classList.remove('hidden');
    $('#upgradeForm').onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.currentTarget).entries());
      try {
        const r = await api('/api/landlord/subscription/pay', { method: 'POST', body: JSON.stringify(body) });
        closeModal(); showToast(r.message || 'Check your phone for the M-Pesa prompt.');
        let tries = 0;
        const timer = setInterval(async () => {
          tries++;
          try {
            const n = await api('/api/landlord/subscription');
            if (n.active && n.paid_until !== s.paid_until) { clearInterval(timer); showToast('Payment received. Your plan is active.'); renderPanel(); }
          } catch (err) {}
          if (tries >= 12) clearInterval(timer);
        }, 5000);
      } catch (err) { showToast(err.message); }
    };
  }
})();


/* Landlord: ask the admin to verify a new address */
window.showAddressRequest = function (p) {
  $('#modalContent').innerHTML = `<div class="eyebrow muted">LANDLORD WORKSPACE</div><h2>Request an address change</h2>
    <p>The address identifies the property, so our team checks every change. Current address: <strong>${esc(p.address || '')}, ${esc(p.town)}, ${esc(p.county)}</strong></p>
    <form id="addrReqForm" class="modal-form">
      <label>New county<input name="county" required value="${esc(p.county)}"></label>
      <label>New town / estate<input name="town" required value="${esc(p.town)}"></label>
      <label>New full address<input name="address" required value="${esc(p.address || '')}"></label>
      <label>Reason, and how we can verify it (for example the plot number or a caretaker's phone number)<textarea name="note" rows="3" required></textarea></label>
      <button class="btn btn-primary full-btn" type="submit">Send to admin</button></form>`;
  $('#modalBackdrop').classList.remove('hidden');
  $('#addrReqForm').onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.currentTarget).entries());
    try {
      await api('/api/properties/' + p.id + '/address-request', { method: 'POST', body: JSON.stringify(body) });
      closeModal(); showToast('Sent to the admin for verification.');
    } catch (err) { showToast(err.message); }
  };
};

async function endTenancy(id) {
  if (!confirm('End this tenancy?\nThe house becomes available again and the tenant can no longer pay rent for it.')) return;
  try {
    await api('/api/landlord/tenancies/' + id + '/end', { method: 'POST', body: '{}' });
    showToast('Tenancy ended. The house is available again.');
    renderPanel();
  } catch (err) { showToast(err.message); }
}

/* Landlord maintenance page */
(function () {
  'use strict';
  const prev = window.renderLandlord;
  window.renderLandlord = async function (host) {
    if (dashboardPanel === 'maintenance') return renderMaint(host);
    return prev(host);
  };
  const prevShow = window.showDashboard;
  window.showDashboard = function () {
    prevShow();
    if (currentUser && currentUser.role === 'landlord') {
      const n = $('#maintenanceNav'); if (n) n.classList.remove('hidden');
    }
  };
  async function renderMaint(host) {
    const d = await api('/api/landlord/maintenance');
    const waiting = d.requests.filter(r => r.status !== 'completed').length;
    const label = { open: 'Open', in_progress: 'In progress', completed: 'Completed' };
    host.innerHTML = `<div class="dash-action"><div><h2>Maintenance requests</h2><p>${waiting ? waiting + ' waiting for you' : 'Nothing waiting right now'}</p></div></div>
      <section class="panel">${d.requests.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>TENANT</th><th>PROPERTY</th><th>ISSUE</th><th>DATE</th><th>STATUS</th></tr></thead><tbody>${d.requests.map(r => `<tr>
        <td><strong>${esc(r.tenant_name)}</strong><br><small>House ${esc(r.house_number || '—')} · ${esc(r.tenant_phone)}</small></td>
        <td>${esc(r.property_title)}<br><small>${esc(r.town)}</small></td>
        <td><strong>${esc(r.title)}</strong><br><small>${esc(r.description || '')}</small></td>
        <td>${dateText(r.created_at)}</td>
        <td><select data-mstatus="${r.id}">${Object.keys(label).map(k => `<option value="${k}" ${r.status === k ? 'selected' : ''}>${label[k]}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-table">Repair requests from your tenants will appear here.</div>'}</section>`;
    $$('[data-mstatus]').forEach(s => s.onchange = async () => {
      try {
        await api('/api/landlord/maintenance/' + s.dataset.mstatus + '/status', { method: 'POST', body: JSON.stringify({ status: s.value }) });
        showToast('Status updated.');
      } catch (err) { showToast(err.message); renderPanel(); }
    });
  }
})();

/* Plan reminder banner: shows when the trial or plan has 3 days or less left */
(function () {
  'use strict';
  const prev = window.renderLandlord;
  window.renderLandlord = async function (host) {
    await prev(host);
    try {
      const s = await api('/api/landlord/subscription');
      const ends = s.active ? s.paid_until : (s.trial_active ? s.trial_ends : null);
      if (!ends) return;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const days = Math.round((new Date(ends) - today) / 86400000);
      if (days < 0 || days > 3) return;
      const what = s.active ? 'monthly plan' : 'free trial';
      const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : 'in ' + days + ' days';
      const bar = document.createElement('section');
      bar.className = 'plan-reminder';
      bar.innerHTML = `<div><strong>Your ${what} ends ${when}</strong><br><small>Renew so you don't lose access to your tenants, rent and maintenance pages.</small></div><button class="btn btn-primary" id="remindRenew">Renew now</button>`;
      host.prepend(bar);
      $('#remindRenew').onclick = () => { dashboardPanel = 'properties'; renderPanel(); };
    } catch (e) {}
  };
})();

/* ---- Rent status (add-on) ---- */
(function () {
  const baseRenderLandlord = renderLandlord;
  renderLandlord = async function (host) {
    await baseRenderLandlord(host);
    if (dashboardPanel !== 'overview' && dashboardPanel !== 'tenants') return;
    let d;
    try { d = await api('/api/landlord/rent-status'); } catch (e) { return; }
    const label = { paid: 'Paid', late: 'Late', due_soon: 'Due soon', upcoming: 'Not due yet' };
    const html = `<section class="panel">${panelHeading('Rent status · ' + esc(d.month),
      d.summary.late + ' late · ' + d.summary.due_soon + ' due soon · ' + d.summary.paid + ' paid')}
      ${d.tenants.length ? `<div class="table-wrap">
      <table class="data-table">
        <thead><tr>
        <th>TENANT</th>
        <th>HOUSE</th>
        <th>RENT</th>
        <th>PAID</th>
        <th>BALANCE</th>
        <th>DUE</th>
        <th>STATUS</th>
      </tr></thead>

        <tbody>${
        d.tenants.map(t => `<tr><td><strong>${esc(t.full_name)}</strong><br><small>${esc(t.phone)}</small></td>
        <td>${esc(t.house_number || '—')}</td>
        <td>${money(t.monthly_rent)}</td>
        <td>${money(t.paid_amount)}</td>
        <td>${money(t.balance)}</td>
        <td>${esc(t.due_date)}</td>
        <td><span class="status-pill rs-${t.status}">${t.status === 'late' ? 'Late ' + t.days_late + ' day' + (t.days_late === 1 ? '' : 's') + (t.months_overdue > 1 ? ' · ' + t.months_overdue + ' months owed' : '') : label[t.status] + (t.months_ahead > 0 ? ' · ' + t.months_ahead + ' month' + (t.months_ahead === 1 ? '' : 's') + ' ahead' : '')}</span>${t.pending ? '<br><small>Prompt sent, awaiting M-Pesa</small>' : ''}</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="empty-table">No active tenancies yet.</div>'}</section>`;
    const grid = host.querySelector('.stat-grid');
    if (grid) grid.insertAdjacentHTML('afterend', html); else host.insertAdjacentHTML('beforeend', html);
  };
})();

document.addEventListener('submit', e => {
  if (e.target && e.target.id === 'searchForm') {
    e.preventDefault();
    loadListings();
  }
});


