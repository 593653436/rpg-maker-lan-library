export function createGameNoticeController({gameId,dialog,trigger,content,heading,fetchGame}){
  let notice='',title='',loaded=false,ready=false,autoShown=false;
  const open=()=>{if(!notice)return false;heading.textContent=`${title} · 管理员公告`;content.textContent=notice;dialog.showModal();return true};
  const autoOpen=()=>{if(loaded&&!autoShown&&notice){autoShown=true;open()}};
  trigger.addEventListener('click',open);
  return{
    async load(){const game=await fetchGame(gameId);title=String(game?.title||'游戏');notice=typeof game?.notice==='string'?game.notice.trim():'';loaded=true;trigger.hidden=!notice;autoOpen();return notice},
    markGameReady(){ready=true},
    open
  };
}
