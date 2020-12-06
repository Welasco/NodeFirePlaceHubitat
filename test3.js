var relay;

function getType( oObj )
{
    if( typeof oObj === "object" )
    {
          return ( oObj === null )?'Null':
          // Check if it is an alien object, for example created as {world:'hello'}
          ( typeof oObj.constructor !== "function" )?'Object':
          // else return object name (string)
          oObj.constructor.name;              
    }   

    // Test simple types (not constructed types)
    return ( typeof oObj === "boolean")?'Boolean':
           ( typeof oObj === "number")?'Number':
           ( typeof oObj === "string")?'String':
           ( typeof oObj === "function")?'Function':false;

}; 

function test() {
    console.log("Before: "+relay);
    typeof relay;
    Object.prototype.toString.call(relay);
    if (Object.prototype.toString.call(relay) != "[object Object]") {
        console.log("It's not a object before");
    }
    //console.log("Check type:  before: "+ (typeof relay) + " ### " + (Object.prototype.toString.call(relay))) + " ### " + getType(relay);
    relay = {
        relay: '1'
    }
    if (Object.prototype.toString.call(relay) == "[object Object]") {
        console.log("It's a object after");
    }    
    //console.log("Check type:  after: "+ (typeof relay) + " ### " + (Object.prototype.toString.call(relay))) + " ### " + getType(relay);
    //console.log("After: "+relay);
}

test();