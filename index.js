var Service;
var Characteristic;
var request = require("request");
var pollingtoevent = require('polling-to-event');
var wol = require('wake_on_lan');

module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    homebridge.registerAccessory("homebridge-philipstv-enhanced", "PhilipsTV", HttpStatusAccessory);
}

function HttpStatusAccessory(log, config) {
    this.log = log;
    var that = this;

    // CONFIG
    this.ip_address = config["ip_address"];
    this.name = config["name"];
    this.poll_status_interval = config["poll_status_interval"] || "0";
    this.model_year = config["model_year"] || "2018";
    this.wol_url = config["wol_url"] || "";
    this.model_year_nr = parseInt(this.model_year);
    this.set_attempt = 0;
    this.has_ssl = config["has_ssl"] || false;
	this.model_name = config["model_name"];
	this.model_version = config["model_version"];
	this.model_serial_no = config["model_serial_no"];

    // CREDENTIALS FOR API
    this.username = config["username"] || "";
    this.password = config["password"] || "";

    // CHOOSING API VERSION BY MODEL/YEAR
    if (this.model_year_nr >= 2016) {
        this.api_version = 6;
    } else if (this.model_year_nr >= 2014) {
        this.api_version = 5;
    } else {
        this.api_version = 1;
    }

    // CONNECTION SETTINGS
    this.protocol = this.has_ssl ? "https" : "https";
    this.portno = this.has_ssl ? "1926" : "1926";
    this.need_authentication = this.username != '' ? 1 : 0;

    this.log("Model year: " + this.model_year_nr);
    this.log("API version: " + this.api_version);

    this.state_power = true;
    this.state_volume = false;      

    this.state_volumeLevel = 0;

    // Define URL & JSON Payload for Actions

    this.base_url = this.protocol + "://" + this.ip_address + ":" + this.portno + "/" + this.api_version;
    // POWER
    this.power_url = this.base_url + "/powerstate";
    this.power_on_body = JSON.stringify({
        "powerstate": "On"
    });
    this.power_off_body = JSON.stringify({
        "powerstate": "Standby"
    });

    // INPUT
    this.input_url = this.base_url + "/input/key";

    // POLLING ENABLED?
    this.interval = parseInt(this.poll_status_interval);
    this.switchHandling = "check";
    if (this.interval > 10 && this.interval < 100000) {
        this.switchHandling = "poll";
    }

    // STATUS POLLING
    if (this.switchHandling == "poll") {
        var statusemitter = pollingtoevent(function(done) {
            that.getPowerState(function(error, response) {
                done(error, response, that.set_attempt);
            }, "statuspoll");
        }, {
            longpolling: true,
            interval: that.interval * 1000,
            longpollEventName: "statuspoll_power"
        });

        statusemitter.on("statuspoll_power", function(data) {
            that.state_power = data;
            if (that.switchService) {
                that.switchService.getCharacteristic(Characteristic.On).setValue(that.state_power, null, "statuspoll");
            }
        });

        var statusemitter_ambilight = pollingtoevent(function(done) {
            that.getAmbilightState(function(error, response) {
                done(error, response, that.set_attempt);
            }, "statuspoll_ambilight");
        }, {
            longpolling: true,
            interval: that.interval * 1000,
            longpollEventName: "statuspoll_ambilight"
        });


        var statusemitter_volume = pollingtoevent(function(done) {        
            that.getVolumeState(function(error, response) {        
                done(error, response, that.set_attempt);       
            }, "statuspoll");      
         }, {       
            longpolling: true,     
            interval: that.interval * 1000,        
            longpollEventName: "statuspoll_volume"     
         });        

          statusemitter.on("statuspoll_volume", function(data) {        
             that.state_volume = data;      
             if (that.VolumeService) {      
                 that.VolumeService.getCharacteristic(Characteristic.On).setValue(that.state_volume, null, "statuspoll");       
             }      
         });        

          var statusemitter_volume_level = pollingtoevent(function(done) {      
             that.getVolumeLevel(function(error, response) {        
                 done(error, response, that.set_attempt);       
             }, "statuspoll");      
         }, {       
             longpolling: true,     
             interval: that.interval * 1000,        
             longpollEventName: "statuspoll_volumeLevel"        
         });        

          statusemitter.on("statuspoll_volumeLevel", function(data) {       
             that.state_volumeLevel = data;     
             if (that.VolumeService) {      
                 that.VolumeService.getCharacteristic(Characteristic.Brightness).setValue(that.state_volumeLevel, null, "statuspoll");      
             }      
         });

        statusemitter_ambilight.on("statuspoll_ambilight", function(data) {
            that.state_ambilight = data;
            if (that.ambilightService) {
                that.ambilightService.getCharacteristic(Characteristic.On).setValue(that.state_ambilight, null, "statuspoll_ambilight");
            }
        });
    }

    // Volume       
     this.audio_url = this.base_url + "/audio/volume";       
     this.audio_unmute_body = JSON.stringify({      
         "muted": false,        
         "current": that.state_volumeLevel      
     });        
     this.audio_mute_body = JSON.stringify({        
         "muted": true,     
         "current": that.state_volumeLevel      
     });



    // AMBILIGHT
	this.status_url_ambilight = this.base_url + "/ambilight/power";

	this.on_url_ambilight = this.base_url + "/ambilight/currentconfiguration";
	this.on_body_ambilight = JSON.stringify({
		"styleName": "FOLLOW_VIDEO",
		"isExpert": false,
		"menuSetting": "NATURAL"
	});

	this.off_url_ambilight = this.status_url_ambilight
	this.off_body_ambilight = JSON.stringify({
		"power": "Off"
	});
}

/////////////////////////////

HttpStatusAccessory.prototype = {

	// Sometime the API fail, all calls should use a retry method, not used yet but goal is to replace all the XLoop function by this generic one
    httpRequest_with_retry: function(url, body, method, need_authentication, retry_count, callback) {
        this.httpRequest(url, body, method, need_authentication, function(error, response, responseBody) {
            if (error) {
                if (retry_count > 0) {
                    this.log('Got error, will retry: ', retry_count, ' time(s)');
                    this.httpRequest_with_retry(url, body, method, need_authentication, retry_count - 1, function(err) {
                        callback(err);
                    });
                } else {
                    this.log('Request failed: %s', error.message);
                    callback(new Error("Request attempt failed"));
                }
            } else {
                callback(null, response, responseBody);
            }
        }.bind(this));
    },

    httpRequest: function(url, body, method, need_authentication, callback) {
        var options = {
            url: url,
            body: body,
            method: method,
            rejectUnauthorized: false,
            timeout: 1000
        };

        // EXTRA CONNECTION SETTINGS FOR API V6 (HTTP DIGEST)
        if (need_authentication) {
            options.followAllRedirects = true;
            options.forever = true;
            options.auth = {
                user: this.username,
                pass: this.password,
                sendImmediately: false
            }
        }

        req = request(options,
            function(error, response, body) {
                callback(error, response, body)
        	}
        );
    },

    wolRequest: function(url, callback) {
        if (!url) {
            callback(null, "EMPTY");
            return;
        }
        if (url.substring(0, 3).toUpperCase() == "WOL") {
            //Wake on lan request
            var macAddress = url.replace(/^WOL[:]?[\/]?[\/]?/ig, "");
            this.log("Excuting WakeOnLan request to " + macAddress);
            wol.wake(macAddress, function(error) {
                if (error) {
                    callback(error);
                } else {
                    callback(null, "OK");
                }
            });
        } else {
            if (url.length > 3) {
                callback(new Error("Unsupported protocol: ", "ERROR"));
            } else {
                callback(null, "EMPTY");
            }
        }
    },

    // Volume       

      setVolumeStateLoop: function(nCount, url, body, volumeState, callback) {      
         var that = this;       

          that.httpRequest(url, body, "POST", this.need_authentication, function(error, response, responseBody) {       
             if (error) {       
                 if (nCount > 0) {      
                     that.setVolumeStateLoop(nCount - 1, url, body, volumeState, function(err, state) {     
                         callback(err, state);      
                     });        
                 } else {          
                     volumeState = false;       
                     callback(new Error("HTTP attempt failed"), volumeState);       
                 }      
             } else {          
                 callback(null, volumeState);       
             }      
         });        
     },     

      setVolumeState: function(volumeState, callback, context) {        
         var url = this.audio_url;      
         var body;      
         var that = this;         

          //if context is statuspoll, then we need to ensure that we do not set the actual value        
         if (context && context == "statuspoll") {      
             callback(null, volumeState);       
             return;        
         }      

          this.set_attempt = this.set_attempt + 1;      

          if (volumeState) {        
             body = this.audio_unmute_body;          
         } else {       
             body = this.audio_mute_body;           
         }      

          that.setVolumeStateLoop(0, url, body, volumeState, function(error, state) {       
             that.state_volume = volumeState;       
             if (error) {       
                 that.state_volume = false;     
                 that.log("setVolumeState - ERROR: %s", error);     
                 that.log("Sent with : %s", url);       
                 that.log("Sent with body : %s", body);     
                 if (that.volumeService) {      
                     that.volumeService.getCharacteristic(Characteristic.On).setValue(that.state_volume, null, "statuspoll");       
                 }      
             }      
             callback(error, that.state_volume);        

          }.bind(this));        
     },     

      setVolumeLevelLoop: function(nCount, url, body, volumeLevel, callback) {      
         var that = this;       

          that.httpRequest(url, body, "POST", this.need_authentication, function(error, response, responseBody) {       
             if (error) {       
                 if (nCount > 0) {        
                     that.setVolumeLevelLoop(nCount - 1, url, body, volumeLevel, function(err, state) {     
                         callback(err, state);      
                     });        
                 } else {       
                     that.log('setVolumeLevelLoop - failed: %s', error.message);        
                     that.log("Sent with : %s", url);       
                     that.log("Sent with body : %s", body);     
                     volumeLevel = false;       
                     callback(new Error("HTTP attempt failed"), volumeLevel);       
                 }      
             } else {       
                 callback(null, volumeLevel);       
             }      
         });        
     },     

      setVolumeLevel: function(volumeLevel, callback, context) {        
         var TV_Adjusted_volumeLevel = Math.round(volumeLevel / 4);     
         var url = this.audio_url;      
         var body = JSON.stringify({"muted": "false", "current": TV_Adjusted_volumeLevel});     
         var that = this;            

          //if context is statuspoll, then we need to ensure that we do not set the actual value        
         if (context && context == "statuspoll") {      
             callback(null, volumeLevel);       
             return;        
         }      

          this.set_attempt = this.set_attempt + 1;      

          // volumeLevel will be in %, let's convert to reasonable values accepted by TV        
         that.setVolumeLevelLoop(0, url, body, volumeLevel, function(error, state) {        
             that.state_volumeLevel = volumeLevel;      
             if (error) {       
                 that.state_volumeLevel = false;        
                 that.log("setVolumeState - ERROR: %s", error);     
                 that.log("Sent with body : %s", body);     
                 if (that.volumeService) {      
                     that.volumeService.getCharacteristic(Characteristic.On).setValue(that.state_volumeLevel, null, "statuspoll");      
                 }      
             }      
             callback(error, that.state_volumeLevel);       
         }.bind(this));     
     },     

      getVolumeState: function(callback, context) {     
         var that = this;       
         var url = this.audio_url;      
    

          //if context is statuspoll, then we need to request the actual value      
        if ((!context || context != "statuspoll") && this.switchHandling == "poll") {       
             callback(null, this.state_volume);     
             return;        
         }      
         if (!this.state_power) {       
                 callback(null, false);     
                 return;        
         }      

          this.httpRequest(url, "", "GET", this.need_authentication, function(error, response, responseBody) {      
             var tResp = that.state_volume;     
             var fctname = "getVolumeState";        
             if (error) {       
                that.log("getVolumeState with : %s", url);      
                 that.log('%s - ERROR: %s', fctname, error.message);        
             } else {       
                 if (responseBody) {        
                    var responseBodyParsed;     
                     try {      
                        responseBodyParsed = JSON.parse(responseBody);      
                        if (responseBodyParsed) {       
                            tResp = (responseBodyParsed.muted == "true") ? 0 : 1;       
                       
                        } else {        
                            that.log("%s - Could not parse message: '%s', not updating state", fctname, responseBody);      
                        }       
                    } catch (e) {       
                        that.log("getVolumeState with : %s", url);      
                         that.log("%s - Got non JSON answer - not updating state: '%s'", fctname, responseBody);        
            responseBodyParsed = false;     
                     }      
                 }      
                 if (that.state_volume != tResp) {      
                        
                    that.state_volume = tResp;      
                 }      
             }      
             callback(null, tResp);     
         }.bind(this));     
     },     

      getVolumeLevel: function(callback, context) {     
         var that = this;       
         var url = this.audio_url;            
         //if context is statuspoll, then we need to request the actual value       
        if ((!context || context != "statuspoll") && this.switchHandling == "poll") {       
             callback(null, this.state_volumeLevel);        
             return;        
         }      
         if (!this.state_power) {       
                 callback(null, 0);     
                 return;        
         }      

          this.httpRequest(url, "", "GET", this.need_authentication, function(error, response, responseBody) {      
             var tResp = that.state_volumeLevel;        
             var fctname = "getVolumeLevel";        
             if (error) {       
                that.log("getVolumeLevel with : %s", url);      
                 that.log('%s - ERROR: %s', fctname, error.message);        
             } else {       
                 if (responseBody) {        
                     var responseBodyParsed;        
                     try {      
                        responseBodyParsed = JSON.parse(responseBody);      
                        if (responseBodyParsed) {       
                            tResp = Math.round(4 * responseBodyParsed.current);     
                        } else {        
                            that.log("%s - Could not parse message: '%s', not updating level", fctname, responseBody);      
                        }       
                     } catch (e) {      
                        that.log("getVolumeLevel with : %s", url);      
                         that.log("%s - Got non JSON answer - not updating level: '%s'", fctname, responseBody);        
            responseBodyParsed = false;     
                     }      
                 }      
                if (that.state_volumeLevel != tResp) {          
                    that.state_volumeLevel = tResp;     
                }       
             }      
             callback(null, that.state_volumeLevel);        
         }.bind(this));     
     },

    // POWER FUNCTIONS -----------------------------------------------------------------------------------------------------------
    setPowerStateLoop: function(nCount, url, body, powerState, callback) {
        var that = this;

        that.httpRequest(url, body, "POST", this.need_authentication, function(error, response, responseBody) {
            if (error) {
                if (nCount > 0) {
                    that.setPowerStateLoop(nCount - 1, url, body, powerState, function(err, state_power) {
                        callback(err, state_power);
                    });
                } else {
                    that.log('setPowerStateLoop - failed: %s', error.message);
                    powerState = false;
                    callback(new Error("HTTP attempt failed"), powerState);
                }
            } else {
                callback(null, powerState);
            }
        });
    },

    setPowerState: function(powerState, callback, context) {
        var url = this.power_url;
        var body;
        var that = this;

        if (context && context == "statuspoll") {
				callback(null, powerState);
				return;
        }

        this.set_attempt = this.set_attempt + 1;

        if (powerState) {
            if (this.model_year_nr <= 2013) {
                this.log("Power On is not possible for model_year before 2014.");
                callback(new Error("Power On is not possible for model_year before 2014."));
            }
            body = this.power_on_body;
			// If Mac Addr for WOL is set
			if (this.wol_url) {
				that.log('setPowerState - Sending WOL');
				this.wolRequest(this.wol_url, function(error, response) {
					//execute the callback immediately, to give control back to homekit
					callback(error, that.state_power);
					that.setPowerStateLoop(8, url, body, powerState, function(error, state_power) {
						that.state_power = state_power;
						if (error) {
							that.state_power = false;
							that.log("setPowerStateLoop - ERROR: %s", error);
							if (that.switchService) {
								that.switchService.getCharacteristic(Characteristic.On).setValue(that.state_power, null, "statuspoll");
							}
						}
					});
				}.bind(this));
			}
        } else {
            body = this.power_off_body;
            that.setPowerStateLoop(0, url, body, powerState, function(error, state_power) {
                that.state_power = state_power;
                if (error) {
                    that.state_power = false;
                    that.log("setPowerStateLoop - ERROR: %s", error);
                }
                if (that.switchService) {
                    that.switchService.getCharacteristic(Characteristic.On).setValue(that.state_power, null, "statuspoll");
                }
                if (that.ambilightService) {
                    that.state_ambilight = false;
                    that.ambilightService.getCharacteristic(Characteristic.On).setValue(that.state_ambilight, null, "statuspoll");
                }
                 if (that.volumeService) {
                    that.state_volume = false;
                    that.volumeService.getCharacteristic(Characteristic.On).setValue(that.state_volume, null, "statuspoll");
                }
                callback(error, that.state_power);
            }.bind(this));
        }
    },

    getPowerState: function(callback, context) {
        var that = this;
        var url = this.power_url;
        //if context is statuspoll, then we need to request the actual value else we return the cached value
		if ((!context || context != "statuspoll") && this.switchHandling == "poll") {
            callback(null, this.state_power);
            return;
        }

        this.httpRequest(url, "", "GET", this.need_authentication, function(error, response, responseBody) {
            var tResp = that.state_power;
            var fctname = "getPowerState";
            if (error) {
				that.log("getPowerState with : %s", url);
                that.log('%s - ERROR: %s', fctname, error.message);
                that.state_power = false;
            } else {
                if (responseBody) {
                    var responseBodyParsed;
                    try {
                        responseBodyParsed = JSON.parse(responseBody);
                        if (responseBodyParsed && responseBodyParsed.powerstate) {
                        	tResp = (responseBodyParsed.powerstate == "On") ? 1 : 0;
						} else {
		                    that.log("%s - Could not parse message: '%s', not updating state", fctname, responseBody);
						}
                    } catch (e) {
						that.log("getPowerState with : %s", url);
                        that.log("%s - Got non JSON answer - not updating state: '%s'", fctname, responseBody);
			responseBodyParsed = false;
                    }
                }
                if (that.state_power != tResp) {
	                that.state_power = tResp;
                }
            }
            callback(null, that.state_power);
        }.bind(this));
    },

    /// Send a key  -----------------------------------------------------------------------------------------------------------
    sendKey: function(key, callback, context) {

        var keyName = null;
        if (key == Characteristic.RemoteKey.ARROW_UP) {
            keyName = "CursorUp";
        } else if (key == Characteristic.RemoteKey.ARROW_LEFT) {
            keyName = "CursorLeft";
        } else if (key == Characteristic.RemoteKey.ARROW_RIGHT) {
            keyName = "CursorRight";
        } else if (key == Characteristic.RemoteKey.ARROW_DOWN) {
            keyName = "CursorDown";
        } else if (key == Characteristic.RemoteKey.BACK) {
            keyName = "Back";
        } else if (key == Characteristic.RemoteKey.EXIT) {
            keyName = "Exit";
        } else if (key == Characteristic.RemoteKey.INFORMATION) {
            keyName = "Home";
        } else if (key == Characteristic.RemoteKey.SELECT) {
            keyName = "Confirm";
        } else if (key == Characteristic.RemoteKey.PLAY_PAUSE) {
            keyName = "PlayPause";
        }
         else if (key == 'VolumeUp') {
            keyName = "VolumeUp";
        } else if (key == 'VolumeDown') {
            keyName = "VolumeDown";
        }
        if (keyName != null) {
            url = this.input_url;
            body = JSON.stringify({"key": keyName});
            this.httpRequest(url, body, "POST", this.need_authentication, function(error, response, responseBody) {
                if (error) {
                    this.log('sendKey - error: ', error.message);
                } 
            }.bind(this));
        }
        callback(null, null);
    },

    identify: function(callback) {
        callback(); // success
    },

    setAmbilightState: function(ambilightState, callback, context) {
		var that = this;

		//if context is statuspoll, then we need to ensure that we do not set the actual value
		if (context && context == "statuspoll") {
			callback(null, ambilightState);
			return;
		}

        var url = (ambilightState) ? this.on_url_ambilight : this.off_url_ambilight;
		var body = (ambilightState) ? this.on_body_ambilight : this.off_body_ambilight;
        that.httpRequest(url, body, "POST", this.need_authentication, function(error, response, responseBody) 
        {
            if (error) {
				that.log('setAmbilightState - failed: %s', error.message);
				callback(new Error("HTTP attempt failed"), false);
            } else {
                callback(null, ambilightState);
            }
        });
	},

	getAmbilightState: function(callback, context) {
		var that = this;
		//if context is not statuspoll, then we need to get the stored value
		if ((!context || context != "statuspoll_ambilight") && this.switchHandling == "poll") {
			callback(null, this.state_ambilight);
			return;
		}
        that.httpRequest(this.status_url_ambilight, "", "GET", this.need_authentication, function(error, response, responseBody) 
        {
			var powerState = 0;
			if (!error) {
				if (responseBody) {
					var responseBodyParsed = JSON.parse(responseBody);
					if (responseBodyParsed && responseBodyParsed.power) {
                        powerState = (responseBodyParsed.power == "On") ? 1 : 0;
					}
				}
			} else {
				that.log('getAmbilightState - actual mode - failed: %s', error.message);
			}

			if (that.state_ambilight != powerState) {
				that.log('getAmbilightState - statechange to: %s', powerState);
			}

			that.state_ambilight = powerState;
			callback(null, powerState);
		}.bind(this));
    },
    
    getServices: function()
    {
        var that = this;

        var informationService = new Service.AccessoryInformation();
        informationService
            .setCharacteristic(Characteristic.Name, this.name)
            .setCharacteristic(Characteristic.Manufacturer, 'Philips')
            .setCharacteristic(Characteristic.Model, this.model_name)
			.setCharacteristic(Characteristic.FirmwareRevision, this.model_version)
			.setCharacteristic(Characteristic.SerialNumber, this.model_serial_no);


        this.televisionService = new Service.Television();
	    this.televisionService
            .setCharacteristic(Characteristic.ConfiguredName, "TV " + this.name);

        // POWER
         

        this.televisionService
            .setCharacteristic(
                 Characteristic.SleepDiscoveryMode,
                 Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE
            );

        this.televisionService
             .getCharacteristic(Characteristic.Active)
             .on('get', this.getPowerState.bind(this))
             .on('set', this.setPowerState.bind(this));

        this.televisionService
            .getCharacteristic(Characteristic.RemoteKey)
            .on('get', this.getPowerState.bind(this))
            .on('set', this.sendKey.bind(this));

        this.switchService = new Service.Switch(this.name);
        this.switchService
            .getCharacteristic(Characteristic.On)
            .on('get', this.getPowerState.bind(this))
            .on('set', this.setPowerState.bind(this));

        this.ambilightService = new Service.Lightbulb(this.name + " Ambilight");
        this.ambilightService
            .getCharacteristic(Characteristic.On)
            .on('get', this.getAmbilightState.bind(this))
            .on('set', this.setAmbilightState.bind(this));

        this.speakerService = new Service.TelevisionSpeaker(this.name + " Volume", "volumeService");        

          this.speakerService       
             .setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE)        
             .setCharacteristic(        
                 Characteristic.VolumeControlType,      
                 Characteristic.VolumeControlType.ABSOLUTE      
             );     

          this.speakerService       
             .getCharacteristic(Characteristic.VolumeSelector)      
             .on('set', (state, callback) => {      
             var keyName;       
             if(state === 1) {      
                 keyName = 'VolumeDown';        
             } else {       
                 keyName = 'VolumeUp';      
             }      
             this.sendKey(keyName,callback,null);       
         });        
         this.speakerService        
             .getCharacteristic(Characteristic.Mute)        
             .on('get', this.getVolumeState.bind(this))     
             .on('set', this.setVolumeState.bind(this));        

          this.speakerService       
             .addCharacteristic(Characteristic.Volume)      
             .on('get', this.getVolumeLevel.bind(this))     
             .on('set', this.setVolumeLevel.bind(this));

        return [informationService, this.televisionService, this.ambilightService, this.speakerService];
    }
};
