import { restyledLayer } from '../color-tables.js';
import Map from 'ol/Map.js';
import { createXYZ } from 'ol/tilegrid.js';
import { rasterNativeZoom } from '../raster-resolution.js';
import View from 'ol/View.js';
import Overlay from 'ol/Overlay.js';
import TileLayer from 'ol/layer/Tile.js';
import WebGLTileLayer from 'ol/layer/WebGLTile.js';
import TileWMS from 'ol/source/TileWMS.js';
import XYZ from 'ol/source/XYZ.js';
import GeoTIFF from 'ol/source/GeoTIFF.js';
import DataTile from 'ol/source/DataTile.js';
import VectorLayer from 'ol/layer/Vector.js';
import OSM from 'ol/source/OSM.js';
import VectorSource from 'ol/source/Vector.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import { fromLonLat, toLonLat, transformExtent } from 'ol/proj.js';
import { Circle, Fill, Stroke, Style } from 'ol/style.js';
import 'ol/ol.css';
import '../style.css';
import { CENTER, ZOOM, TILE_URL, ATTRIBUTION, STATION_COLOR, STATION_RADIUS, WMS_SERVER } from '../config.js';
import { createOpenLayersAdapter } from './openlayers-adapter.js';
import { createGribReader } from '../grib-reader.js';
import { xyzBounds } from '../cog-reader.js';
import { waitForMapEvent } from './timing.js';

import { cogUrl, gribUrl, weatherTileUrl, cogStyle, rasterUrl } from '../weather.js';
import { stationContent, setStatus, TILE_ERROR_MESSAGE } from '../ui.js';

export function createOpenLayersMapFactory(stations) {
  return async (surface, index, signal, startup = {}) => {
    signal.throwIfAborted();
    const basemap = new OSM({ url: TILE_URL, attributions: ATTRIBUTION, maxZoom: 19 });
    basemap.on('tileloaderror', () => setStatus(TILE_ERROR_MESSAGE, true));
    let stationLayer, map;
    try {
      stationLayer = new VectorLayer({
        visible: !startup.benchmark,
        source: new VectorSource({
          features: new GeoJSON().readFeatures(structuredClone(stations), { featureProjection: 'EPSG:3857' }),
        }),
        style: new Style({
          image: new Circle({
            radius: STATION_RADIUS,
            fill: new Fill({ color: STATION_COLOR }),
            stroke: new Stroke({ color: '#ffffff', width: 2 }),
          }),
        }),
      });
      const view = new View({ center: fromLonLat(startup.camera?.center ?? CENTER), zoom: startup.camera?.zoom ?? ZOOM, minZoom: 1, maxZoom: 19, enableRotation: false });
      const basemapLayer = new TileLayer({ source: basemap, visible: !startup.benchmark && index === 1 });
      map = new Map({
        target: surface,
        layers: [basemapLayer, stationLayer],
        view,
      });

      const popupElement = document.createElement('div');
      popupElement.className = 'ol-popup';
      const popup = new Overlay({ element: popupElement, positioning: 'bottom-center', offset: [0, -12], autoPan: true });
      map.addOverlay(popup);
      map.on('singleclick', (event) => {
        const feature = map.forEachFeatureAtPixel(event.pixel, (item) => item, { layerFilter: (layer) => layer === stationLayer });
        popup.setPosition(undefined);
        if (!feature) return;
        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = '×';
        close.setAttribute('aria-label', 'Close popup');
        close.addEventListener('click', () => popup.setPosition(undefined));
        popupElement.replaceChildren(close, stationContent(feature.getProperties()));
        popup.setPosition(event.coordinate);
      });
      map.on('pointermove', (event) => {
        map.getTargetElement().style.cursor = map.hasFeatureAtPixel(event.pixel) ? 'pointer' : '';
      });

      const createOverlay = (layer, mode, onError, id = 'weather') => {
        let source, overlay, reader;
        const maxNativeZoom = rasterNativeZoom(layer);
        if (mode === 'cog') {
          source = new GeoTIFF({ sources: [{ url: cogUrl(layer), bands: [1], nodata: layer.nodata }],
            projection: 'EPSG:4326', normalize: false, transition: 0,
            interpolate: layer.style.resampling !== 'nearest',
            sourceOptions: { allowFullFile: false } });
          overlay = new WebGLTileLayer({ source, opacity: 0.7, style: cogStyle(layer) });
        } else if (mode === 'grib') {
          reader = createGribReader(gribUrl(layer), layer);
          source = new DataTile({ tileSize: 256, bandCount: 4, maxZoom: maxNativeZoom,
            projection: 'EPSG:3857', wrapX: false, transition: 0, interpolate: layer.style.resampling !== 'nearest',
            loader: async (z, x, y) => new Uint8Array(await reader.render(xyzBounds(z, x, y), 256, 256)),
            attributions: 'DWD ICON forecast' });
          overlay = new WebGLTileLayer({ source, opacity: 0.7 });
        } else {
          source = mode === 'wms'
            ? new TileWMS({ url: rasterUrl(`${WMS_SERVER}/wms`, layer), params: { LAYERS: layer.id,
              VERSION: '1.1.1', FORMAT: 'image/png', TRANSPARENT: true },
              hidpi: false, transition: 0, tileGrid: createXYZ({ tileSize: 256, maxZoom: maxNativeZoom }),
              wrapX: false, interpolate: layer.style.resampling !== 'nearest', attributions: 'DWD ICON forecast' })
            : new XYZ({ url: weatherTileUrl(layer, mode), tileSize: 256, maxZoom: maxNativeZoom,
              wrapX: false, interpolate: layer.style.resampling !== 'nearest',
              transition: 0, attributions: 'DWD ICON forecast' });
          overlay = new TileLayer({ source, opacity: 0.7 });
        }
        overlay.setExtent(transformExtent(layer.bounds, 'EPSG:4326', 'EPSG:3857'));
        source.on('tileloaderror', onError);
        source.on('error', onError);
        map.getLayers().insertAt(1, overlay);
        return {
          restyle: mode === 'xyz' ? undefined : async () => {
            const styled = restyledLayer(layer);
            if (mode === 'cog') overlay.setStyle(cogStyle(styled));
            else if (mode === 'grib') {
              await reader.restyle(styled.style);
              source.refresh();
            } else if (mode === 'wms') source.updateParams({ STYLES: styled.colorTableStyle });
          },
          ready: reader?.ready,
          async settle(signal) {
            if (mode === 'cog') await source.getView();
            await waitForMapEvent({ on: map.on.bind(map), off: map.un.bind(map),
              trigger: () => map.render() }, 'rendercomplete', signal);
          },
          remove() { reader?.dispose(); map.removeLayer(overlay); overlay.dispose(); source.dispose(); },
          setVisible(visible) { overlay.setVisible(visible); },
        };
      };
      return {
        surface, createOverlay,
        adapter: createOpenLayersAdapter(map, basemapLayer, stationLayer, popup),
        getCamera: () => ({ center: toLonLat(view.getCenter()), zoom: view.getZoom() }),
        onCameraChange(handler) {
          const types = ['change:center', 'change:resolution'];
          types.forEach((type) => view.on(type, handler));
          return () => types.forEach((type) => view.un(type, handler));
        },
        setStationsVisible(visible) { stationLayer.setVisible(visible); popup.setPosition(undefined); },
        destroy() { map.setTarget(undefined); map.dispose(); basemap.dispose(); stationLayer.getSource().dispose(); stationLayer.dispose(); },
      };
    } catch (error) {
      map?.setTarget(undefined); map?.dispose(); basemap.dispose();
      stationLayer?.getSource()?.dispose(); stationLayer?.dispose();
      throw error;
    }
  };
}
