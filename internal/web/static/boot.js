// Starts the page script named by <body data-page>. Kept out of the HTML so the Content Security Policy can forbid inline script.
(function(){
 var b=document.body,p=b.getAttribute('data-page');
 document.querySelectorAll('[data-w]').forEach(function(e){e.style.width=e.getAttribute('data-w')+'%'});
 if(p==='wire')initWire(b.getAttribute('data-last-run')||'',Number(b.getAttribute('data-stories')||0));
 else if(p==='filtered')initFiltered();
 else if(p==='squad'&&window.initSquad)initSquad();
})();
