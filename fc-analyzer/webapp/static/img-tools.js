/* 图片自动降档工具：尺寸/字节超阈值时 canvas 压缩，返回新 File。
   阈值：最长边 1600px 或 1.5MB，压缩为 JPEG 0.85。失败时原样返回。 */
(function () {
  window.downscaleImageFile = function (file, opts) {
    opts = opts || {};
    var maxDim = opts.maxDim || 1600;
    var maxBytes = opts.maxBytes || 1.5 * 1024 * 1024;
    return new Promise(function (resolve) {
      if (!file || !file.type || file.type.indexOf('image/') !== 0) return resolve(file);
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth || 0;
        var h = img.naturalHeight || 0;
        URL.revokeObjectURL(url);
        var scale = Math.min(1, maxDim / Math.max(w, h, 1));
        if (scale === 1 && file.size <= maxBytes) return resolve(file);  // 不大，原样
        var cw = Math.max(1, Math.round(w * scale));
        var ch = Math.max(1, Math.round(h * scale));
        try {
          var canvas = document.createElement('canvas');
          canvas.width = cw;
          canvas.height = ch;
          canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
          canvas.toBlob(function (b) {
            if (!b) return resolve(file);
            var name = ((file.name || 'pasted.png').replace(/\.\w+$/, '')) + '.jpg';
            resolve(new File([b], name, { type: 'image/jpeg' }));
          }, 'image/jpeg', 0.85);
        } catch (e) {
          resolve(file);
        }
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  };
})();
