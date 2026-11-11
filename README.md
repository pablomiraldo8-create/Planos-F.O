# Mapa de Trazas – FO Tigo

App web para ver la traza de fibra de Tigo, cargar los KMZ de obras de terceros, detectar cruces y puntos de riesgo, dibujar y sacar una imagen profesional para mandar por mail.

## Archivos
- `index.html` – la página
- `style.css` – el diseño
- `app.js` – todo el funcionamiento

**IMPORTANTE:** no subas los KMZ de la red (Red_Tigo_3en1.kmz ni ningún otro) a GitHub. El repositorio es público. La base Tigo se carga desde el aparato y queda guardada solo en ese navegador.

## Publicarla en GitHub Pages
1. En github.com → **New repository** → nombre `mapa-trazas` → Public → Create.
2. **Add file → Upload files** → arrastrá `index.html`, `style.css`, `app.js` y `README.md` → **Commit changes**.
3. **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main` / `(root)` → **Save**.
4. Esperá 1–2 minutos. La dirección queda: `https://TU-USUARIO.github.io/mapa-trazas/`

## Primer uso (en cada aparato: PC y celular)
1. Abrí la dirección.
2. En el panel de capas tocá **Cargar base Tigo** y elegí `Red_Tigo_3en1.kmz`. Queda fija.
3. En el celular: menú del navegador → **Agregar a pantalla de inicio**.

## Uso diario
- **+ Cargar KMZ / KML**: cargás la obra que te mandaron. Se pinta arriba de la traza y se analizan los riesgos solo.
- **👁**: mostrar / ocultar capas y carpetas. **📌**: fijar una obra para que quede guardada. **✕**: eliminarla. El cuadradito de color cambia el color de la obra.
- **⚠ Riesgos**: lista de cruces y puntos cercanos. *Ver* te lleva al punto, *Imagen* saca la lámina con zoom de ese punto.
- **⬇ Descargar imagen**: lámina con encabezado, fecha, dirección, leyenda, escala y norte.
- **✎ Dibujar**: punto, texto, línea, flecha, círculo, cuadrado, mano alzada y borrar.
- **Mantener apretado / clic derecho** en el mapa: dirección de ese punto.
- **⚙ Configuración**: nombres de cámaras, colores y metros de riesgo, textos de la lámina.

## Actualizar la app
Subí de nuevo el archivo cambiado con **Add file → Upload files** (reemplaza al anterior). Si no ves el cambio, recargá la página con Ctrl+F5.
