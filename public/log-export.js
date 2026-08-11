(() => {
  globalThis.__mistDownloadJsonLog=function(report){
    const captured=String(report?.capturedAt||new Date().toISOString()).replace(/[:.]/g,'-'),game=String(report?.gameId||'unknown').replace(/[^\w-]/g,'_'),filename=`mist-game-log-${game}-${captured}.json`;
    const blob=new Blob(['\uFEFF',JSON.stringify(report,null,2)],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),anchor=document.createElement('a');
    anchor.href=url;anchor.download=filename;anchor.style.display='none';document.body.appendChild(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),0);return{filename};
  };
})();
