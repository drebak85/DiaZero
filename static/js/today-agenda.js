import { supabase } from './supabaseClient.js';
import { planificarMejorasHoy } from './mejoras-planner.js';

function limpiarEtiquetasDescripcion(txt) {
  if (!txt) return '';
  // Quita una etiqueta inicial en corchetes: [Mejora], [Cita], [Tarea], [Requisito], [Documento], [Rutina]
  return txt.replace(/^\s*\[(?:mejora|cita|tarea|requisito|documento|rutina)\]\s*/i, '');
}


const container = document.getElementById('agenda-container');

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}
function rutinaTerminadaHoy(rutina) {
  if (!rutina.end_time || !rutina.end_time.includes(':')) return false;
  const ahora = new Date();
  const [h, m] = rutina.end_time.split(':').map(Number);
  const fin = new Date();
  fin.setHours(h, m, 0, 0);
  return ahora > fin;
}
function formatHora(hora) {
  if (!hora || hora === '00:00:00') return '';
  return hora.slice(0,5);
}
function daysLeft(dateStr){
  if(!dateStr) return null;
  const t=new Date(); t.setHours(0,0,0,0);
  const d=new Date(dateStr); d.setHours(0,0,0,0);
  return Math.round((d - t)/86400000);
}

async function cargarAgendaHoy() {
  const hoy = new Date();
  const diaSemanaEsp = hoy.toLocaleDateString('es-ES', { weekday: 'long' });
  const hoyStr = hoy.toISOString().split('T')[0];
  let actividades = [];

  // 🔸 Planificar mejoras del día (idempotente por UNIQUE)
  await planificarMejorasHoy({
    presupuestoMin: 60,
    bloquesPermitidos: [25, 15],
    maxTareas: 4
  });

const { data: { user } } = await supabase.auth.getUser();
const uid    = user?.id || null;                                   // UUID
const email  = user?.email || null;                                // email (compat)
const stored = localStorage.getItem('usuario_actual') || null;     // por si hay fallback
const who = [uid, email, stored].filter(Boolean);                  // acepta ambos

if (!who.length) {
  console.warn('[AGENDA] No hay usuario autenticado');
  renderizarActividades([]);
  return;
}


// BORRAR tareas completadas de días anteriores (solo del usuario actual)
const { error: delErr } = await supabase
  .from('tasks')
  .delete()
  .lt('due_date', hoyStr)
  .eq('is_completed', true)
.in('usuario', who)
if (delErr) console.error('❌ Error borrando tareas viejas:', delErr);


// MOVER SOLO tareas normales (sin improvement) de días anteriores al día actual
const { error: updErr } = await supabase
  .from('tasks')
  .update({ due_date: hoyStr })
  .lt('due_date', hoyStr)
  .eq('is_completed', false)
.in('usuario', who)
  .is('improvement_id', null);   // 👈 clave: NO tocar mejoras
if (updErr) console.error('❌ Error moviendo tareas viejas:', updErr);


// TAREAS (incluyendo requisitos, mejoras y documentos)
const { data: tareas, error: errorTareas } = await supabase
  .from('tasks')
  .select('*')                 // trae document_id también
  .eq('due_date', hoyStr)
.in('usuario', who)

if (!errorTareas && tareas) {
  // ➊ leer las fechas de caducidad de los documentos asociados a estas tareas
  let docCaducidades = {};
  const docIds = tareas.map(t => t.document_id).filter(Boolean);
  if (docIds.length) {
    const uniques = [...new Set(docIds)];
    const { data: docs, error: docsErr } = await supabase
      .from('documentos')
      .select('id,caduca_el,usuario')
      .in('id', uniques)
.in('usuario', who)
    if (!docsErr && docs) {
      docCaducidades = Object.fromEntries(docs.map(d => [d.id, d.caduca_el]));
    }
  }

  // ➋ construir las actividades (añadimos document_id y doc_days_left)
const tareasFormateadas = tareas.map(t => {
  const idxNum = Number.isFinite(Number(t.requirement_index))
    ? Number(t.requirement_index)
    : null;

  const caduca = t.document_id ? docCaducidades[t.document_id] : null;
  const left = caduca ? daysLeft(caduca) : null;

  // Construir descripción con cuenta atrás para documentos
  let descripcion = t.description;
  if (t.document_id && left != null) {
    let tag = null;
    if (left < 0)        tag = 'CADUCADO';
    else if (left === 0) tag = 'CADUCA HOY';
    else if (left <= 30) tag = `quedan ${left} días`;
    if (tag) descripcion = `${t.description} (${tag})`;
  }

  return {
    tipo: 'Tarea',
    id: t.id,
    descripcion,                   // 👈 ahora con cuenta atrás
    start: t.start_time || '',
    end: t.end_time || '',
    completado: t.is_completed,
    prioridad: t.priority,
    appointment_id: t.appointment_id ?? null,
    requirement_index: idxNum,
    improvement_id: t.improvement_id ?? null,
    document_id: t.document_id ?? null,
    doc_days_left: left            // 👈 seguimos guardando el left para estilos
  };
});


  actividades = actividades.concat(tareasFormateadas);
}


  // RUTINAS
  const { data: rutinas, error: errorRutinas } = await supabase
    .from('routines')
    .select('*')
    .eq('is_active', true)
.in('usuario', who)

  if (!errorRutinas && rutinas) {
    const rutinasDelDia = rutinas.filter(r => {
      const cumpleDiaSemana =
        Array.isArray(r.days_of_week) &&
        r.days_of_week.includes(capitalize(diaSemanaEsp));

      const f0 = (d) => new Date(new Date(d).getFullYear(), new Date(d).getMonth(), new Date(d).getDate());
      const fechaInicio = f0(r.date);
      const fechaFin = r.end_date ? f0(r.end_date) : null;
      const fechaHoy = f0(hoy);

      return (
        cumpleDiaSemana &&
        fechaInicio <= fechaHoy &&
        (!fechaFin || fechaHoy <= fechaFin)
      );
    });

    const rutinasFormateadas = rutinasDelDia.map(r => ({
      tipo: 'Rutina',
      id: r.id,
      descripcion: r.description,
      start: r.start_time || '',
      end: r.end_time || '',
      completado: rutinaTerminadaHoy(r)
    }));

    actividades = actividades.concat(rutinasFormateadas);
  }

  renderizarActividades(actividades);
}

function renderizarActividades(actividades) {
  container.innerHTML = '';
  if (actividades.length === 0) {
    container.innerHTML = '<p class="no-citas-msg">No hay actividades para hoy.</p>';
    return;
  }

  const ahora = new Date();

  actividades.sort((a, b) => {
    if (a.completado !== b.completado) return a.completado ? 1 : -1;
    return (a.start || '').localeCompare(b.start || '');
  });

  actividades.forEach(act => {
const actDiv = document.createElement('div');
actDiv.classList.add('actividad-item', act.tipo.toLowerCase());
if (act.completado) actDiv.classList.add('actividad-completada');

// --- Subtipo (colores) ---
const subtipo =
  (act.tipo === 'Tarea' && act.appointment_id != null && act.requirement_index != null) ? 'requisito' :
  (act.tipo === 'Tarea' && act.improvement_id != null)                                   ? 'mejora'    :
  (act.tipo === 'Tarea' && act.document_id != null)                                      ? 'documento' :
  (act.tipo === 'Rutina')                                                                ? 'rutina'    :
                                                                                          'tarea';

actDiv.classList.add(`subtipo-${subtipo}`);
actDiv.dataset.subtipo = subtipo;

// Fondo especial para tareas de documentos según caducidad (mantener tu lógica actual)
if (act.tipo === 'Tarea' && act.document_id) {
  actDiv.classList.add('actividad-doc');
  const left = act.doc_days_left;
  if (left != null) {
    if (left < 0)        actDiv.classList.add('estado-expired');
    else if (left === 0) actDiv.classList.add('estado-today');
    else if (left <= 30) actDiv.classList.add('estado-soon');
  }
}



    let tiempo = '';
    let startsSoon = false; // 👈 NUEVO

    if (act.start && act.start.includes(':')) {
      const [sh, sm] = act.start.split(':').map(Number);
      const inicio = new Date();
      inicio.setHours(sh, sm, 0, 0);
      const diffInicio = inicio - ahora;

      if (diffInicio > 0) {
        const min = Math.floor(diffInicio / (1000 * 60));
        if (min < 60) {
              if (min < 30) startsSoon = true;

          tiempo = `Empieza en ${min} min`;
        } else if (min < 1440) {
          const horas = Math.floor(min / 60);
          const minutos = min % 60;
          tiempo = `Empieza en ${horas} h ${minutos} min`;
        } else {
          const dias = Math.floor(min / 1440);
          const horas = Math.floor((min % 1440) / 60);
          tiempo = `Empieza en ${dias} d ${horas} h`;
        }
      } else if (act.end && act.end.includes(':')) {
        const [eh, em] = act.end.split(':').map(Number);
        const fin = new Date();
        fin.setHours(eh, em, 0, 0);
        const diffFin = fin - ahora;

        if (diffFin > 0) {
          const min = Math.floor(diffFin / (1000 * 60));
          if (min >= 60) {
            const horas = Math.floor(min / 60);
            const minutos = min % 60;
            tiempo = `Termina en ${horas} h${minutos > 0 ? ` ${minutos} min` : ''}`;
          } else {
            tiempo = `Termina en ${min} min`;
          }
        } else {
          tiempo = 'Terminada';
        }
      } else {
        tiempo = 'En curso';
      }
    } else {
      tiempo = 'Sin hora';
    }

    // ¿Es una tarea que viene de un requisito de cita?
    const esRequisitoDeCita =
      act.tipo === 'Tarea' &&
      act.appointment_id != null &&
      act.requirement_index != null;

    // Si es requisito, no mostramos el botón borrar
    // Si es requisito, no mostramos el botón borrar
const borrarBtnHtml = esRequisitoDeCita
  ? ''
  : `<button class="btn-borrar"
        data-id="${act.id}"
        data-tipo="${act.tipo}"
        ${act.appointment_id != null ? `data-aid="${act.appointment_id}"` : ''}
        ${act.requirement_index != null ? `data-idx="${act.requirement_index}"` : ''}>
      <span class="circle-btn red">🗑️</span>
    </button>`;

// >>> AÑADE ESTO (resalta cuenta atrás en tareas de documento)
// 1) Limpia etiquetas tipo [Mejora], [Cita], etc.
let descripcionHTML = limpiarEtiquetasDescripcion(act.descripcion);

// 2) Resalta la cuenta atrás de documentos si existe
if (act.tipo === 'Tarea' && act.document_id) {
  descripcionHTML = descripcionHTML.replace(
    /\((?:quedan \d+ d[ií]as|CADUCA HOY|CADUCADO)\)/i,
    m => `<span class="doc-countdown">${m}</span>`
  );
}

actDiv.innerHTML = `
  <div class="actividad-info">
    <span class="actividad-hora">
      ${formatHora(act.start)}${formatHora(act.end) ? ` - ${formatHora(act.end)}` : ''}
    </span>
<span class="actividad-descripcion">
  <span class="actividad-chip subtipo-${subtipo}">${subtipo === 'tarea' ? 'Tarea' : (subtipo === 'requisito' ? 'Requisito' : (subtipo === 'mejora' ? 'Mejora' : (subtipo === 'documento' ? 'Documento' : 'Rutina')))}</span>
  ${descripcionHTML}
</span>
    <span class="actividad-tiempo">${tiempo}</span>
  </div>
  <div class="actividad-actions">
    <button class="btn-check"
            data-id="${act.id}"
            data-tipo="${act.tipo}"
            data-completado="${act.completado}"
            ${act.tipo === 'Rutina' ? 'disabled' : ''}
            ${act.appointment_id != null ? `data-aid="${act.appointment_id}"` : ''}
            ${act.requirement_index != null ? `data-idx="${act.requirement_index}"` : ''}
            ${act.improvement_id != null ? `data-improvement-id="${act.improvement_id}"` : ''}>
      <span class="circle-btn green">✔️</span>
    </button>
    <button class="btn-editar" data-id="${act.id}" data-tipo="${act.tipo}">
      <span class="circle-btn yellow">✏️</span>
    </button>
    ${borrarBtnHtml}
  </div>
`;


    if (startsSoon && !act.completado) {
  actDiv.classList.add('latido'); // 👈 NUEVO
}
container.appendChild(actDiv);

  });

  agregarEventos();
}

function agregarEventos() {
  // Completar tarea (sync mejora y/o cita)
  document.querySelectorAll('.btn-check').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const btnEl = e.currentTarget;
      if (!btnEl) return;

      const { id, tipo, completado, aid, idx, improvementId } = {
        id: btnEl.dataset.id,
        tipo: btnEl.dataset.tipo,
        completado: btnEl.dataset.completado,
        aid: btnEl.dataset.aid,
        idx: btnEl.dataset.idx,
        improvementId: btnEl.dataset.improvementId
      };

      const actual = completado === 'true';
      const nuevoEstado = !actual;

      if (tipo === 'Tarea') {
        // 1) Marcar la tarea
        const { error } = await supabase
          .from('tasks')
          .update({ is_completed: nuevoEstado })
          .eq('id', id);
        if (error) {
          console.error('❌ Error completando tarea:', error);
          return;
        }

        // 2) Si es mejora, actualizar last_done_at cuando se completa
        if (improvementId && nuevoEstado === true) {
          const hoyStr = new Date().toISOString().split('T')[0];
          const { error: updMejErr } = await supabase
            .from('mejoras')
            .update({ last_done_at: hoyStr })
            .eq('id', improvementId);
          if (updMejErr) console.warn('⚠️ No se pudo actualizar last_done_at:', updMejErr);
        }

        // 3) Si está vinculada a cita, sincronizar requisito
        const idxNum = Number.isFinite(Number(idx)) ? Number(idx) : null;
        if (aid && Number.isInteger(idxNum)) {
          const { data: appt, error: err1 } = await supabase
            .from('appointments')
            .select('requirements')
            .eq('id', aid)
            .single();

          if (!err1 && appt && Array.isArray(appt.requirements)) {
            const reqs = appt.requirements.map(r =>
              typeof r === 'string'
                ? { text: r, checked: false }
                : { text: r?.text || '', checked: !!r?.checked }
            );

            if (reqs[idxNum]) reqs[idxNum].checked = nuevoEstado;

            const { error: err2 } = await supabase
              .from('appointments')
              .update({ requirements: reqs })
              .eq('id', aid);
            if (err2) console.error('❌ Error sync cita desde tarea:', err2);

            window.dispatchEvent(new CustomEvent('requisito-actualizado', {
              detail: { citaId: aid, index: idxNum, checked: nuevoEstado }
            }));
          }
        }

        cargarAgendaHoy();
      }
    });
  });

  // Borrar actividad (rutina o tarea normal; las de requisito no muestran botón)
  document.querySelectorAll('.btn-borrar').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const btnEl = e.currentTarget;
      if (!btnEl) return;

      const { id, tipo } = btnEl.dataset;

      if (tipo !== 'Tarea') {
        const { error: delRutErr } = await supabase.from('routines').delete().eq('id', id);
        if (delRutErr) console.error('❌ Error al borrar rutina:', delRutErr);
        cargarAgendaHoy();
        return;
      }

      // 1) Leer la tarea (por si fuera de mejora, para posibles acciones futuras)
      const { data: task, error: taskErr } = await supabase
        .from('tasks')
        .select('appointment_id, requirement_index, improvement_id')
        .eq('id', id)
        .single();

      if (taskErr) {
        console.error('❌ No se pudo leer la tarea antes de borrar:', taskErr);
        return;
      }

      // 2) Borrar por id
      const { error: delErr } = await supabase.from('tasks').delete().eq('id', id);
      if (delErr) {
        console.error('❌ Error al borrar tarea:', delErr);
        return;
      }

      // 3) Si era requisito de cita, desmarcar en la cita
      const aid = task?.appointment_id;
      const idxNum = Number.isFinite(Number(task?.requirement_index)) ? Number(task.requirement_index) : null;

      if (aid && Number.isInteger(idxNum)) {
        const { data: appt, error: apptErr } = await supabase
          .from('appointments')
          .select('requirements')
          .eq('id', aid)
          .single();

        if (!apptErr && appt && Array.isArray(appt.requirements)) {
          const reqs = appt.requirements.map(r =>
            typeof r === 'string'
              ? { text: r, checked: false }
              : { text: r?.text || '', checked: !!r?.checked }
          );
          if (reqs[idxNum]) reqs[idxNum].checked = false;

          const { error: updErr } = await supabase
            .from('appointments')
            .update({ requirements: reqs })
            .eq('id', aid);

          if (!updErr) {
            window.dispatchEvent(new CustomEvent('requisito-actualizado', {
              detail: { citaId: aid, index: idxNum, checked: false }
            }));
          }
        }
      }

      cargarAgendaHoy();
    });
  });

  // Editar actividad (tareas/rutinas)
  document.querySelectorAll('.btn-editar').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.currentTarget.dataset.id;
      const tipo = e.currentTarget.dataset.tipo;

      const { data, error } = await supabase
        .from(tipo === 'Tarea' ? 'tasks' : 'routines')
        .select('*')
        .eq('id', id)
        .single();

      if (error || !data) {
        console.error("No se pudo obtener la actividad:", error);
        return;
      }

      const formContainer = document.createElement('div');
      formContainer.classList.add('form-overlay');
      formContainer.innerHTML = `
        <form class="formulario-edicion">
          <h3>Editar ${tipo}</h3>
          <label>Descripción:
            <input type="text" name="descripcion" value="${data.description}" required>
          </label>
          <label>Hora inicio:
            <input type="time" name="start" value="${data.start_time || ''}">
          </label>
          <label>Hora fin:
            <input type="time" name="end" value="${data.end_time || ''}">
          </label>
          <div class="form-botones">
            <button type="submit">Guardar</button>
            <button type="button" id="cancelarEdicion">Cancelar</button>
          </div>
        </form>
      `;
      document.body.appendChild(formContainer);
      formContainer.querySelector('#cancelarEdicion').onclick = () => formContainer.remove();

      formContainer.querySelector('form').onsubmit = async (ev) => {
        ev.preventDefault();
        const nuevaDescripcion = ev.target.descripcion.value;
        const nuevaHoraInicio = ev.target.start.value;
        const nuevaHoraFin = ev.target.end.value;

        const { error: errorUpdate } = await supabase
          .from(tipo === 'Tarea' ? 'tasks' : 'routines')
          .update({
            description: nuevaDescripcion,
            start_time: nuevaHoraInicio || null,
            end_time: nuevaHoraFin || null
          })
          .eq('id', id);

        if (errorUpdate) {
          console.error("Error al actualizar:", errorUpdate);
        } else {
          formContainer.remove();
          cargarAgendaHoy();
        }
      };
    });
  });
}

cargarAgendaHoy();
window.cargarAgendaHoy = cargarAgendaHoy;

// Refrescos ante eventos externos (citas)
window.addEventListener('requisito-actualizado', () => {
  cargarAgendaHoy();
});
window.addEventListener('cita-borrada', () => {
  cargarAgendaHoy();
});
