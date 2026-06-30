addEventListener("fetch", function(event) {
  try {
    var fn = new Function("return 42");
    var result = fn();
    event.respondWith(new Response(JSON.stringify({ok:true,result:result,version:"eval-test"}),{
      headers:{"Content-Type":"application/json"}
    }));
  } catch(e) {
    event.respondWith(new Response(JSON.stringify({ok:false,error:e.message}),{
      status:500, headers:{"Content-Type":"application/json"}
    }));
  }
});
